/**
 * MCP connection domain logic: CRUD, OAuth flow orchestration, entitlement
 * enforcement, ownership checks, and at-rest encryption of credentials.
 *
 * Security invariants enforced here:
 *  - Secrets (tokens, client secrets) are encrypted before touching the DB and
 *    are never included in any value returned to the client.
 *  - Ownership is checked on every mutation: a row that doesn't belong to the
 *    session user is indistinguishable from "not found" (404).
 *  - The free-tier 3-server limit is enforced server-side *before* creating a
 *    connection, using the existing billing/plan system.
 *  - Errors are wrapped in `ApiError` with sanitized messages so the generic
 *    `handleApiError` logger cannot leak credentials.
 *  - Disconnect revokes tokens upstream (best-effort) and deletes the row so
 *    secrets are purged from the database immediately.
 */
import { and, count, eq, inArray } from "drizzle-orm";

import { getDb, type DB } from "#/db";
import { billingAccount, mcpServer, subscription } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import type { BillingPlan } from "./entitlements.server";
import { assertCanConnectServer, decideConnection } from "./entitlements.server";
import { FREE_SERVER_LIMIT, McpServerStatus, type McpEnv } from "./config.server";
import {
  decryptJson,
  encryptJson,
  importEncryptionKey,
  type McpEncryptionKey,
} from "./crypto.server";
import { createId } from "./id.server";
import {
  sanitizeScopes,
  type AuthorizationServerMetadata,
  type ProtectedResourceMetadata,
} from "./oauth.server";
import { buildAuthorizationUrl, generatePkce } from "./oauth.server";
import { discover, probeMcpServer } from "./discovery.server";
import {
  exchangeCodeForTokens,
  registerDynamicClient,
  revokeToken,
  type McpAuthData,
} from "./client.server";
import {
  createStateToken,
  deriveStateKey,
  verifyStateToken,
  type StateHmacKey,
} from "./state.server";
import { validateMcpServerUrl, type ValidateUrlOptions } from "./url.server";

/** Wire-safe projection returned to the client. NEVER includes secrets. */
export interface McpServerView {
  id: string;
  name: string;
  serverUrl: string;
  status: string;
  /** Non-sensitive, server-authored metadata from discovery. */
  resource: ProtectedResourceMetadata;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Persisted (non-secret) snapshot of the discovery result. */
interface StoredDiscovery {
  resource: ProtectedResourceMetadata;
  authorizationServer: AuthorizationServerMetadata;
  serverOrigin: string;
}

function parseDiscoveryMeta(raw: string | null): StoredDiscovery | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredDiscovery;
  } catch {
    return null;
  }
}

function toView(row: typeof mcpServer.$inferSelect): McpServerView {
  const discovery = parseDiscoveryMeta(row.discoveryMeta);
  return {
    id: row.id,
    name: row.name,
    serverUrl: row.serverUrl,
    status: row.status,
    resource: discovery?.resource ?? {},
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sanitizeName(input: unknown): string {
  if (typeof input !== "string") throw new ApiError(400, "Name is required");
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new ApiError(400, "Name is required");
  if (trimmed.length > 80) throw new ApiError(400, "Name must be 80 characters or fewer");
  // Strip control chars; names are user-visible.
  return trimmed.replace(/[\p{Cc}\u007f]/gu, "");
}

const OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

function loopbackOptions(env: McpEnv): ValidateUrlOptions {
  // Permit http+loopback only when the app itself is running over http (dev).
  const appUrl = env.BETTER_AUTH_URL ?? "";
  return { allowLoopbackHttp: appUrl.startsWith("http://") };
}

interface ResolvedKeys {
  encryption: McpEncryptionKey;
  state: StateHmacKey;
}

async function keys(env: McpEnv): Promise<ResolvedKeys> {
  if (!env.MCP_ENCRYPTION_KEY) {
    throw new ApiError(500, "MCP feature is not configured");
  }
  return {
    encryption: await importEncryptionKey(env.MCP_ENCRYPTION_KEY),
    state: await deriveStateKey(env.MCP_ENCRYPTION_KEY),
  };
}

const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const;

/**
 * Resolve the user's billing plan directly from D1 (subscriptions are
 * synced there by the Stripe webhook). This intentionally reuses the existing
 * billing/entitlement data model rather than bundling Stripe env into the MCP
 * surface, so MCP works on any worker that already has billing configured.
 */
async function loadPlan(env: McpEnv, userId: string): Promise<BillingPlan> {
  const db = getDb(env.DB);
  const account = await db.query.billingAccount.findFirst({
    where: eq(billingAccount.userId, userId),
  });
  if (!account) return "free";
  const subs = await db.query.subscription.findMany({
    where: and(
      eq(subscription.billingAccountId, account.id),
      inArray(subscription.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
    ),
  });
  return subs.some((s) => s.plan === "pro_monthly") ? "pro_monthly" : "free";
}

async function assertOwnership(
  db: DB,
  userId: string,
  serverId: string,
): Promise<typeof mcpServer.$inferSelect> {
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  if (!row) throw new ApiError(404, "MCP server not found");
  return row;
}

/** Count connections that count toward the free-tier limit (active + pending). */
async function countTowardLimit(db: DB, userId: string): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(mcpServer)
    .where(
      and(
        eq(mcpServer.userId, userId),
        // Only active/pending consume a slot; disconnected rows are deleted.
        // SQLite has no boolean, so we compare strings.
        eq(mcpServer.status, McpServerStatus.active),
      ),
    );
  const pendingRows = await db
    .select({ c: count() })
    .from(mcpServer)
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.status, McpServerStatus.pending)));
  return (rows[0]?.c ?? 0) + (pendingRows[0]?.c ?? 0);
}

// ---------------------------------------------------------------------------
// Public domain operations
// ---------------------------------------------------------------------------

export async function listMcpServers(
  env: McpEnv,
  userId: string,
): Promise<{
  servers: McpServerView[];
  plan: BillingPlan;
  limit: number | null;
  remaining: number | null;
}> {
  const db = getDb(env.DB);
  const rows = await db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  const plan = await loadPlan(env, userId);
  // Exclude soft deleted/disconnected from the limit math; those rows are
  // deleted, so counts only include active/pending.
  const used = rows.filter(
    (r) => r.status === McpServerStatus.active || r.status === McpServerStatus.pending,
  ).length;
  const decision = decideConnection(plan, used);
  return {
    servers: rows.map(toView),
    plan,
    limit: decision.limit,
    remaining: decision.remaining,
  };
}

export interface CreateConnectionInput {
  name: string;
  serverUrl: string;
}

/**
 * Create a pending MCP connection record, run discovery, and return the
 * authorization URL the client should open to start OAuth. Also performs the
 * entitlement check (free-tier 3-server limit) before any work.
 */
export async function beginConnection(
  env: McpEnv,
  userId: string,
  input: CreateConnectionInput,
  appOrigin: string,
): Promise<{ server: McpServerView; authorizationUrl: string; redirectUri: string }> {
  const name = sanitizeName(input.name);
  const validated = validateMcpServerUrl(input.serverUrl, loopbackOptions(env));
  const db = getDb(env.DB);

  // Enforce server-side entitlement limit BEFORE discovery/insert.
  const plan = await loadPlan(env, userId);
  assertCanConnectServer(plan, await countTowardLimit(db, userId));

  // Discover metadata. Throws sanitized ApiError on failure.
  const discovered = await discover(validated.href, loopbackOptions(env));
  // Reject servers that don't support PKCE S256 — we won't downgrade security.
  const methods = discovered.authorizationServer.code_challenge_methods_supported;
  if (methods && !methods.includes("S256")) {
    throw new ApiError(422, "MCP server does not support PKCE S256");
  }

  const redirectUri = `${new URL(appOrigin).origin}${OAUTH_CALLBACK_PATH}`;
  const scopes = sanitizeScopes(discovered.authorizationServer.scopes_supported);
  let clientId = "mcp-client";
  let clientSecret: string | undefined;
  if (discovered.authorizationServer.registration_endpoint) {
    const registered = await registerDynamicClient(
      discovered.authorizationServer.registration_endpoint,
      redirectUri,
      scopes,
      loopbackOptions(env),
    );
    if (registered) {
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
    }
  }

  const id = createId("mcp");
  const pkce = await generatePkce();
  const k = await keys(env);
  const state = await createStateToken(k.state, {
    serverId: id,
    userId,
    codeVerifier: pkce.codeVerifier,
  });

  // Persist discovery snapshot (no secrets) + draft client id (encrypted) so
  // we can complete the flow even if the server goes away momentarily.
  const discovery: StoredDiscovery = {
    resource: discovered.resource,
    authorizationServer: discovered.authorizationServer,
    serverOrigin: discovered.serverOrigin,
  };
  const pendingAuth: McpAuthData = {
    accessToken: "",
    clientId,
    clientSecret,
    tokenEndpoint: discovered.authorizationServer.token_endpoint,
    revocationEndpoint: discovered.authorizationServer.revocation_endpoint,
  };

  try {
    await db.insert(mcpServer).values({
      id,
      userId,
      name,
      serverUrl: validated.href,
      status: McpServerStatus.pending,
      discoveryMeta: JSON.stringify(discovery),
      authDataEncrypted: await encryptJson(k.encryption, pendingAuth),
    });
  } catch (err) {
    // Unique(user,url) collision -> friendly 409.
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("UNIQUE") || /constraint/i.test(msg)) {
      throw new ApiError(409, "You already connected this MCP server");
    }
    throw err;
  }

  const authorizationUrl = buildAuthorizationUrl(
    discovered.authorizationServer.authorization_endpoint!,
    { clientId, redirectUri, state, codeChallenge: pkce.codeChallenge, scopes },
  );

  const row = await assertOwnership(db, userId, id);
  return { server: toView(row), authorizationUrl, redirectUri };
}

/**
 * OAuth callback: verify signed state belongs to the session user, exchange the
 * authorization code, encrypt the resulting tokens, and flip the row to
 * `active`. Solidifies ownership by checking `state.userId === sessionUserId`.
 */
export async function completeConnection(
  env: McpEnv,
  sessionUserId: string,
  input: { state: string; code: string },
  appOrigin: string,
): Promise<{ serverId: string }> {
  if (typeof input.code !== "string" || input.code.length === 0) {
    throw new ApiError(400, "Missing authorization code");
  }
  const k = await keys(env);
  let state;
  try {
    state = await verifyStateToken(k.state, input.state);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "Invalid OAuth state");
  }
  if (state.userId !== sessionUserId) {
    // Forged/swapped state: do not reveal whether the server exists.
    throw new ApiError(403, "OAuth state does not belong to this account");
  }

  const db = getDb(env.DB);
  const row = await assertOwnership(db, sessionUserId, state.serverId);
  const discovery = parseDiscoveryMeta(row.discoveryMeta);
  if (!discovery) throw new ApiError(409, "Reconnect this MCP server to continue");

  // Decrypt the draft client credentials created during beginConnection.
  const draft = await decryptJson<McpAuthData>(k.encryption, row.authDataEncrypted ?? "");
  const redirectUri = `${new URL(appOrigin).origin}${OAUTH_CALLBACK_PATH}`;

  let tokens: McpAuthData;
  try {
    tokens = await exchangeCodeForTokens({
      tokenEndpoint: discovery.authorizationServer.token_endpoint!,
      code: input.code,
      codeVerifier: state.codeVerifier,
      redirectUri,
      clientId: draft.clientId ?? "mcp-client",
      clientSecret: draft.clientSecret,
      options: loopbackOptions(env),
    });
  } catch (err) {
    // Persist a sanitized error so the user sees why they need to reconnect.
    const message = err instanceof ApiError ? err.message : "Authorization failed";
    await db
      .update(mcpServer)
      .set({
        lastError: message.slice(0, 200),
        status: McpServerStatus.error,
        updatedAt: new Date(),
      })
      .where(and(eq(mcpServer.id, row.id), eq(mcpServer.userId, sessionUserId)));
    throw err;
  }

  tokens.revocationEndpoint = discovery.authorizationServer.revocation_endpoint;
  const encrypted = await encryptJson(k.encryption, tokens);
  await db
    .update(mcpServer)
    .set({
      authDataEncrypted: encrypted,
      status: McpServerStatus.active,
      lastError: null,
      lastTestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, row.id), eq(mcpServer.userId, sessionUserId)));

  return { serverId: row.id };
}

/** Re-run the OAuth flow for an existing (error/disconnected/any) connection. */
export async function reconnectServer(
  env: McpEnv,
  userId: string,
  serverId: string,
  appOrigin: string,
): Promise<{ server: McpServerView; authorizationUrl: string; redirectUri: string }> {
  const db = getDb(env.DB);
  const row = await assertOwnership(db, userId, serverId);
  const k = await keys(env);
  const redirectUri = `${new URL(appOrigin).origin}${OAUTH_CALLBACK_PATH}`;

  // Refresh discovery + re-register a client, then start OAuth with a new PKCE.
  const discovered = await discover(row.serverUrl, loopbackOptions(env));
  const scopes = sanitizeScopes(discovered.authorizationServer.scopes_supported);
  let clientId = "mcp-client";
  let clientSecret: string | undefined;
  if (discovered.authorizationServer.registration_endpoint) {
    const registered = await registerDynamicClient(
      discovered.authorizationServer.registration_endpoint,
      redirectUri,
      scopes,
      loopbackOptions(env),
    );
    if (registered) {
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
    }
  }

  const pkce = await generatePkce();
  const state = await createStateToken(k.state, {
    serverId: row.id,
    userId,
    codeVerifier: pkce.codeVerifier,
  });

  const discovery: StoredDiscovery = {
    resource: discovered.resource,
    authorizationServer: discovered.authorizationServer,
    serverOrigin: discovered.serverOrigin,
  };
  const draft: McpAuthData = {
    accessToken: "",
    clientId,
    clientSecret,
    tokenEndpoint: discovered.authorizationServer.token_endpoint,
    revocationEndpoint: discovered.authorizationServer.revocation_endpoint,
  };
  await db
    .update(mcpServer)
    .set({
      discoveryMeta: JSON.stringify(discovery),
      authDataEncrypted: await encryptJson(k.encryption, draft),
      status: McpServerStatus.pending,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, row.id), eq(mcpServer.userId, userId)));

  const authorizationUrl = buildAuthorizationUrl(
    discovered.authorizationServer.authorization_endpoint!,
    { clientId, redirectUri, state, codeChallenge: pkce.codeChallenge, scopes },
  );

  const refreshed = await assertOwnership(db, userId, row.id);
  return { server: toView(refreshed), authorizationUrl, redirectUri };
}

export interface EditServerInput {
  name?: string;
  serverUrl?: string;
}

export async function editServer(
  env: McpEnv,
  userId: string,
  serverId: string,
  input: EditServerInput,
): Promise<McpServerView> {
  const db = getDb(env.DB);
  const row = await assertOwnership(db, userId, serverId);

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) update.name = sanitizeName(input.name);
  if (input.serverUrl !== undefined) {
    const validated = validateMcpServerUrl(input.serverUrl, loopbackOptions(env));
    if (validated.href !== row.serverUrl) {
      // URL changed: tokens are no longer valid; require a reconnect.
      update.serverUrl = validated.href;
      update.status = McpServerStatus.pending;
      update.authDataEncrypted = null;
      update.discoveryMeta = null;
      update.lastError = null;
    }
  }

  await db
    .update(mcpServer)
    .set(update)
    .where(and(eq(mcpServer.id, row.id), eq(mcpServer.userId, userId)));
  const updated = await assertOwnership(db, userId, serverId);
  return toView(updated);
}

/** Live-test the stored credentials against the MCP server. */
export async function testServer(
  env: McpEnv,
  userId: string,
  serverId: string,
): Promise<{ ok: boolean; message: string; status: number }> {
  const db = getDb(env.DB);
  const row = await assertOwnership(db, userId, serverId);
  if (row.status !== McpServerStatus.active || !row.authDataEncrypted) {
    throw new ApiError(409, "Reconnect this MCP server before testing");
  }
  const k = await keys(env);
  const auth = await decryptJson<McpAuthData>(k.encryption, row.authDataEncrypted);

  const result = await probeMcpServer(row.serverUrl, auth.accessToken, loopbackOptions(env));
  await db
    .update(mcpServer)
    .set({
      lastTestedAt: new Date(),
      lastError: result.ok ? null : result.message.slice(0, 200),
      status: result.ok ? McpServerStatus.active : McpServerStatus.error,
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, row.id), eq(mcpServer.userId, userId)));
  return result;
}

/** Delete the connection and best-effort revoke its tokens upstream. */
export async function disconnectServer(
  env: McpEnv,
  userId: string,
  serverId: string,
): Promise<void> {
  const db = getDb(env.DB);
  const row = await assertOwnership(db, userId, serverId);
  if (row.authDataEncrypted) {
    try {
      const k = await keys(env);
      const auth = await decryptJson<McpAuthData>(k.encryption, row.authDataEncrypted);
      const discovery = parseDiscoveryMeta(row.discoveryMeta);
      const revocationEndpoint =
        auth.revocationEndpoint ?? discovery?.authorizationServer.revocation_endpoint;
      if (revocationEndpoint) {
        await revokeToken({
          revocationEndpoint,
          token: auth.accessToken,
          clientId: auth.clientId,
          clientSecret: auth.clientSecret,
          options: loopbackOptions(env),
        });
      }
    } catch {
      // Best-effort: we still delete the row to purge secrets locally.
    }
  }
  await db.delete(mcpServer).where(and(eq(mcpServer.id, row.id), eq(mcpServer.userId, userId)));
}

export { FREE_SERVER_LIMIT };
