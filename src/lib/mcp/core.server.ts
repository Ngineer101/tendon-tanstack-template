// Core MCP server lifecycle logic: discovery, connect, reconnect, edit, test,
// disconnect, listing. Enforces the free-tier 3-server limit server-side
// using the existing billing/subscription projection in D1.

import { and, eq, inArray, lt } from "drizzle-orm";

import { getDb } from "#/db";
import { ApiError } from "#/lib/api-error";
import { billingAccount, mcpOAuthState, mcpServer, subscription } from "#/db/schema";
import {
  type McpEnv,
  FREE_MCP_SERVER_LIMIT,
  OAUTH_STATE_TTL_MS,
  getRedirectUri,
} from "./config.server";
import { decryptSecret, encryptSecret } from "./crypto.server";
import {
  buildAuthorizationUrl,
  discoverOAuthMetadata,
  exchangeCode,
  randomBase64Url,
  registerDynamicClient,
  shouldAllowLocalhost,
  type OAuthMetadata,
  type StoredAuth,
} from "./oauth.server";
import { safeFetch, validateServerUrl } from "./ssrf.server";

// Subscription plan that lifts the free-tier MCP server limit. This mirrors
// the `pro_monthly` plan check used by `getBillingSummary` in the billing core
// so MCP limit enforcement stays consistent with the existing entitlement
// system, without coupling MCP to the Stripe env.
const UNLIMITED_PLAN = "pro_monthly";
const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const;

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

// Shape returned to the client. Never includes tokens or endpoint secrets.
export interface McpServerPublic {
  id: string;
  name: string;
  serverUrl: string;
  status: "pending" | "connected" | "disconnected" | "error";
  lastError: string | null;
  hasCredentials: boolean;
  createdAt: string;
  updatedAt: string;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  supportsDynamicRegistration: boolean;
}

function toPublic(row: typeof mcpServer.$inferSelect): McpServerPublic {
  return {
    id: row.id,
    name: row.name,
    serverUrl: row.serverUrl,
    status: row.status as McpServerPublic["status"],
    lastError: row.lastError,
    hasCredentials: !!row.encryptedAuth,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    authorizationEndpoint: row.authorizationEndpoint,
    tokenEndpoint: row.tokenEndpoint,
    supportsDynamicRegistration: !!row.registrationEndpoint,
  };
}

export interface McpListResult {
  servers: McpServerPublic[];
  limit: number | null; // null == unlimited
  used: number;
}

// Reads the existing subscription projection to determine whether the user
// has the unlimited allowance. Same source of truth as the billing core's
// `hasEntitlement`, but scoped to only the rows MCP actually needs.
async function hasUnlimitedAllowance(env: McpEnv, userId: string): Promise<boolean> {
  const db = getDb(env.DB);
  const account = await db.query.billingAccount.findFirst({
    where: eq(billingAccount.userId, userId),
  });
  if (!account) return false;
  const subs = await db
    .select()
    .from(subscription)
    .where(
      and(
        eq(subscription.billingAccountId, account.id),
        inArray(subscription.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
      ),
    );
  return subs.some((s) => s.plan === UNLIMITED_PLAN);
}

export async function listServers(env: McpEnv, userId: string): Promise<McpListResult> {
  const db = getDb(env.DB);
  const rows = await db
    .select()
    .from(mcpServer)
    .where(eq(mcpServer.userId, userId))
    .orderBy(mcpServer.createdAt);
  // Disconnected servers do not count toward the limit.
  const used = rows.filter((r) => r.status !== "disconnected").length;
  const unlimited = await hasUnlimitedAllowance(env, userId);
  return {
    servers: rows.map(toPublic),
    limit: unlimited ? null : FREE_MCP_SERVER_LIMIT,
    used,
  };
}

async function assertUnderLimit(env: McpEnv, userId: string) {
  const { limit, used } = await listServers(env, userId);
  if (limit !== null && used >= limit) {
    throw new ApiError(
      402,
      `You can connect up to ${limit} MCP servers on the free plan. Upgrade to Pro for unlimited servers.`,
      { limit, used, code: "mcp_limit_reached" },
    );
  }
}

// Discover OAuth metadata for a candidate URL. Does not persist anything.
export async function discover(
  env: McpEnv,
  input: { serverUrl: string; name?: string },
  appOrigin: string,
): Promise<{ validatedUrl: string; metadata: OAuthMetadata; name: string }> {
  const validated = validateServerUrl(input.serverUrl, {
    allowLocalhost: shouldAllowLocalhost(env),
  });
  if (env.BETTER_AUTH_URL) {
    if (isSameHost(validated.origin, env.BETTER_AUTH_URL)) {
      throw new ApiError(400, "Cannot connect a server that points back at this app");
    }
  }
  const metadata = await discoverOAuthMetadata(env, validated.url, appOrigin);
  const name = (input.name ?? "").trim() || deriveNameFromUrl(validated.url);
  return { validatedUrl: validated.url, metadata, name };
}

function isSameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

function deriveNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "MCP server";
  }
}

export interface ConnectResult {
  serverId: string;
  authorizationUrl: string;
}

// Create the server row + start the OAuth flow. Returns the URL the client
// must redirect to. Stores PKCE state in `mcp_oauth_state`.
export async function connectServer(
  env: McpEnv,
  userId: string,
  input: { serverUrl: string; name?: string },
  appOrigin: string,
): Promise<ConnectResult> {
  await assertUnderLimit(env, userId);
  const { validatedUrl, metadata, name } = await discover(env, input, appOrigin);

  const db = getDb(env.DB);
  const id = createId("mcp");
  await db.insert(mcpServer).values({
    id,
    userId,
    name,
    serverUrl: validatedUrl,
    authorizationEndpoint: metadata.authorizationEndpoint,
    tokenEndpoint: metadata.tokenEndpoint,
    registrationEndpoint: metadata.registrationEndpoint,
    status: "pending",
  });

  const authorizationUrl = await beginAuth(env, {
    id,
    userId,
    metadata,
  });
  return { serverId: id, authorizationUrl };
}

// Stores PKCE verifier + state and returns the authorization URL to redirect
// the user to. State is consumed exactly once in `handleOAuthCallback`.
async function beginAuth(
  env: McpEnv,
  args: { id: string; userId: string; metadata: OAuthMetadata },
): Promise<string> {
  const db = getDb(env.DB);
  const redirectUri = getRedirectUri(env);
  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(40);
  const authorizationUrl = await buildAuthorizationUrl({
    codeVerifier,
    state,
    metadata: args.metadata,
    redirectUri,
  });
  await db.insert(mcpOAuthState).values({
    id: createId("mcpstate"),
    mcpServerId: args.id,
    userId: args.userId,
    state,
    codeVerifier,
    redirectUri,
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });
  return authorizationUrl;
}

// Re-run OAuth discovery + start a fresh flow against an existing server
// (reconnect after a disconnect or a token failure).
export async function reconnectServer(
  env: McpEnv,
  userId: string,
  serverId: string,
  appOrigin: string,
): Promise<ConnectResult> {
  const db = getDb(env.DB);
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  if (!row) throw new ApiError(404, "MCP server not found");

  const metadata = await discoverOAuthMetadata(env, row.serverUrl, appOrigin);
  await db
    .update(mcpServer)
    .set({
      authorizationEndpoint: metadata.authorizationEndpoint,
      tokenEndpoint: metadata.tokenEndpoint,
      registrationEndpoint: metadata.registrationEndpoint,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(mcpServer.id, row.id));

  const authorizationUrl = await beginAuth(env, { id: row.id, userId, metadata });
  return { serverId: row.id, authorizationUrl };
}

// OAuth callback handler. Validates state, exchanges code for tokens,
// encrypts the stored auth, marks the server connected. State is consumed.
export async function handleOAuthCallback(
  env: McpEnv,
  query: { state?: string; code?: string; error?: string; errorDescription?: string },
  appOrigin: string,
): Promise<{ serverId: string; userId: string }> {
  if (query.error) {
    throw new ApiError(400, query.errorDescription ?? `Authorization error: ${query.error}`);
  }
  if (!query.state || !query.code) {
    throw new ApiError(400, "Missing OAuth callback parameters");
  }

  const db = getDb(env.DB);
  const stateRow = await db.query.mcpOAuthState.findFirst({
    where: eq(mcpOAuthState.state, query.state),
  });
  if (!stateRow) {
    throw new ApiError(400, "Invalid or expired OAuth state");
  }
  if (stateRow.expiresAt.getTime() < Date.now()) {
    await db.delete(mcpOAuthState).where(eq(mcpOAuthState.id, stateRow.id));
    throw new ApiError(400, "The authorization attempt expired. Please try again.");
  }

  // Consume the state exactly once so it cannot be replayed.
  await db.delete(mcpOAuthState).where(eq(mcpOAuthState.id, stateRow.id));

  const server = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, stateRow.mcpServerId), eq(mcpServer.userId, stateRow.userId)),
  });
  if (!server) throw new ApiError(404, "MCP server not found");

  if (!server.authorizationEndpoint || !server.tokenEndpoint) {
    throw new ApiError(409, "MCP server is missing OAuth metadata. Reconnect from the dashboard.");
  }
  const metadata: OAuthMetadata = {
    authorizationEndpoint: server.authorizationEndpoint,
    tokenEndpoint: server.tokenEndpoint,
    registrationEndpoint: server.registrationEndpoint ?? undefined,
  };

  // If dynamic registration is available and we have not registered yet, try
  // now so that the token exchange has a client_id.
  let auth: { clientId?: string; clientSecret?: string } = {};
  const existing = server.encryptedAuth
    ? await decryptSecret<StoredAuth>(env, server.encryptedAuth).catch(() => undefined)
    : undefined;
  if (existing?.clientId) {
    auth = { clientId: existing.clientId, clientSecret: existing.clientSecret };
  } else if (metadata.registrationEndpoint) {
    auth = (await registerDynamicClient(env, metadata, stateRow.redirectUri, appOrigin)) ?? {};
  }

  let stored: StoredAuth;
  try {
    stored = await exchangeCode(env, {
      metadata,
      redirectUri: stateRow.redirectUri,
      auth,
      code: query.code,
      codeVerifier: stateRow.codeVerifier,
      appOrigin,
    });
  } catch (error) {
    await markError(env, server.id, error);
    throw error;
  }

  const encrypted = await encryptSecret(env, stored);
  await db
    .update(mcpServer)
    .set({
      encryptedAuth: encrypted,
      status: "connected",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(mcpServer.id, server.id));

  return { serverId: server.id, userId: stateRow.userId };
}

async function markError(env: McpEnv, serverId: string, error: unknown) {
  const db = getDb(env.DB);
  const message =
    error instanceof ApiError ? error.message : "Unable to complete the MCP server connection";
  await db
    .update(mcpServer)
    .set({ status: "error", lastError: message, updatedAt: new Date() })
    .where(eq(mcpServer.id, serverId));
}

// Edit the human-readable name. Changing the URL resets the connection and
// forces the user to re-authorize against the new server.
export async function editServer(
  env: McpEnv,
  userId: string,
  serverId: string,
  input: { name?: string; serverUrl?: string },
  appOrigin: string,
): Promise<McpServerPublic> {
  const db = getDb(env.DB);
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  if (!row) throw new ApiError(404, "MCP server not found");

  const update: Partial<typeof mcpServer.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new ApiError(400, "Name is required");
    if (name.length > 80) throw new ApiError(400, "Name is too long");
    update.name = name;
  }
  if (input.serverUrl !== undefined && input.serverUrl !== row.serverUrl) {
    const validated = validateServerUrl(input.serverUrl, {
      allowLocalhost: shouldAllowLocalhost(env),
    });
    const dup = await db.query.mcpServer.findFirst({
      where: and(eq(mcpServer.userId, userId), eq(mcpServer.serverUrl, validated.url)),
    });
    if (dup && dup.id !== row.id) {
      throw new ApiError(409, "You already have a server with this URL");
    }
    update.serverUrl = validated.url;
    const metadata = await discoverOAuthMetadata(env, validated.url, appOrigin);
    update.authorizationEndpoint = metadata.authorizationEndpoint;
    update.tokenEndpoint = metadata.tokenEndpoint;
    update.registrationEndpoint = metadata.registrationEndpoint;
    update.encryptedAuth = null;
    update.status = "pending";
    update.lastError = null;
  }

  await db.update(mcpServer).set(update).where(eq(mcpServer.id, row.id));
  const updated = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, row.id) });
  return toPublic(updated as typeof row);
}

// Disconnect: wipe credentials and mark disconnected. The user may later
// reconnect without consuming another server slot.
export async function disconnectServer(
  env: McpEnv,
  userId: string,
  serverId: string,
): Promise<McpServerPublic> {
  const db = getDb(env.DB);
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  if (!row) throw new ApiError(404, "MCP server not found");
  await db
    .update(mcpServer)
    .set({ encryptedAuth: null, status: "disconnected", lastError: null, updatedAt: new Date() })
    .where(eq(mcpServer.id, row.id));
  const updated = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, row.id) });
  return toPublic(updated as typeof row);
}

// Delete a server outright (including all state + pending OAuth states).
export async function deleteServer(env: McpEnv, userId: string, serverId: string): Promise<void> {
  const db = getDb(env.DB);
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  if (!row) throw new ApiError(404, "MCP server not found");
  await db.delete(mcpServer).where(eq(mcpServer.id, row.id));
}

export interface TestResult {
  status: "connected" | "disconnected" | "error";
  message: string;
}

// Test a connection by calling the server with the decrypted bearer token.
// Returns a status the UI can show. Never returns tokens.
export async function testServer(
  env: McpEnv,
  userId: string,
  serverId: string,
  appOrigin: string,
): Promise<TestResult> {
  const db = getDb(env.DB);
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  if (!row) throw new ApiError(404, "MCP server not found");
  if (row.status !== "connected" || !row.encryptedAuth) {
    return {
      status: row.status === "disconnected" ? "disconnected" : "error",
      message: "This server is not connected. Authorize it first.",
    };
  }

  let auth: StoredAuth;
  try {
    auth = await decryptSecret<StoredAuth>(env, row.encryptedAuth);
  } catch {
    await markError(env, row.id, new ApiError(500, "Stored credentials could not be decrypted"));
    return { status: "error", message: "Stored credentials are invalid. Reconnect this server." };
  }

  // Minimal MCP probe: GET the server URL with the bearer token and check the
  // status. Full MCP initialization is out of scope for this starter.
  try {
    const response = await safeFetch(
      row.serverUrl,
      {
        method: "GET",
        timeoutMs: 8_000,
        headers: { accept: "application/json", authorization: `Bearer ${auth.accessToken}` },
      },
      { allowLocalhost: shouldAllowLocalhost(env), appOrigin, maxRedirects: 0 },
    );
    if (response.status >= 500) {
      throw new ApiError(502, `The MCP server returned an error (HTTP ${response.status})`);
    }
    if (response.status === 401 || response.status === 403) {
      await markError(env, row.id, new ApiError(401, "The MCP server rejected the saved token"));
      return { status: "error", message: "The MCP server rejected the saved token. Reconnect it." };
    }
  } catch (error) {
    await markError(env, row.id, error);
    throw error;
  }

  await db
    .update(mcpServer)
    .set({ status: "connected", lastError: null, updatedAt: new Date() })
    .where(eq(mcpServer.id, row.id));
  return { status: "connected", message: "Connection is healthy." };
}

// Periodic cleanup hook (called from the cron). Removes expired OAuth states
// so they cannot be replayed even if a row is left behind by a crash.
export async function purgeExpiredOAuthStates(env: McpEnv): Promise<number> {
  const db = getDb(env.DB);
  const result = await db.delete(mcpOAuthState).where(lt(mcpOAuthState.expiresAt, new Date()));
  return result.meta.changes ?? 0;
}
