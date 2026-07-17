import { and, count, eq, lt, sql } from "drizzle-orm";

import { getDb, type DB } from "#/db";
import { mcpOauthTransaction, mcpServer, user } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { BILLING_CATALOG } from "#/lib/billing/config";
import type { BillingEnv } from "#/lib/billing/config.server";
import { getBillingSummary } from "#/lib/billing/core.server";
import {
  buildAuthorizationUrl,
  discoverOAuthServer,
  exchangeAuthorizationCode,
  generatePkce,
  initializeServer,
  listTools,
  McpAuthRequiredError,
  McpDiscoveryError,
  McpRemoteError,
  refreshAccessToken,
  registerClient,
  type OAuthServerMetadata,
  type RegisteredClient,
  type TokenBundle,
} from "./client.server";
import {
  FREE_TIER_MCP_SERVER_LIMIT,
  MAX_SERVER_NAME_LENGTH,
  OAUTH_TRANSACTION_TTL_MS,
  TOKEN_EXPIRY_SKEW_MS,
  type McpEnv,
} from "./config.server";
import { decryptJson, encryptJson } from "./crypto.server";
import { assertPubliclyResolvable, parsePublicHttpUrl, sanitizeForLog } from "./url.server";

export type McpCoreEnv = McpEnv & BillingEnv;

export type McpServerStatus = "connected" | "requires_auth" | "error";
export type McpAuthType = "oauth" | "none";

export interface McpServerDto {
  id: string;
  name: string;
  url: string;
  status: string;
  authType: string;
  serverName: string | null;
  serverVersion: string | null;
  lastError: string | null;
  lastTestedAt: Date | null;
  createdAt: Date;
}

export interface McpServerQuota {
  plan: "free" | "pro_monthly";
  used: number;
  /** null means unlimited (paid plan). */
  limit: number | null;
}

/** Token material + the client registration needed to refresh it. */
interface StoredAuth {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  tokens: TokenBundle;
}

interface OauthTransactionPayload {
  serverUrl: string;
  name: string;
  /** Set when the flow re-authenticates an existing server row. */
  serverId?: string;
  metadata: OAuthServerMetadata;
  client: RegisteredClient;
  codeVerifier: string;
  redirectUri: string;
}

export class McpServerLimitError extends ApiError {
  constructor(limit: number) {
    super(
      403,
      `Free plan allows up to ${limit} MCP servers. Upgrade to Pro for unlimited servers.`,
      {
        limit,
      },
    );
    this.name = "McpServerLimitError";
  }
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function toDto(row: typeof mcpServer.$inferSelect): McpServerDto {
  // encryptedAuth is deliberately never included in DTOs.
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    status: row.status,
    authType: row.authType,
    serverName: row.serverName,
    serverVersion: row.serverVersion,
    lastError: row.lastError,
    lastTestedAt: row.lastTestedAt,
    createdAt: row.createdAt,
  };
}

export function normalizeServerUrl(url: URL): string {
  const normalized = new URL(url.toString());
  if (normalized.pathname !== "/") {
    normalized.pathname = normalized.pathname.replace(/\/+$/, "");
  }
  return normalized.toString();
}

function validateServerName(name: unknown): string {
  if (typeof name !== "string") throw new ApiError(400, "Enter a display name for the server");
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_SERVER_NAME_LENGTH) {
    throw new ApiError(400, `Enter a display name (1-${MAX_SERVER_NAME_LENGTH} characters)`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listServers(db: DB, userId: string): Promise<McpServerDto[]> {
  const rows = await db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  });
  return rows.map(toDto);
}

export async function getServerQuota(env: McpCoreEnv, userId: string): Promise<McpServerQuota> {
  const db = getDb(env.DB);
  const summary = await getBillingSummary(env, userId);
  const unlimited =
    summary.plan === "pro_monthly" &&
    BILLING_CATALOG.subscriptionPlans.pro_monthly.entitlements.includes("unlimited_mcp_servers");
  const rows = await db
    .select({ value: count() })
    .from(mcpServer)
    .where(eq(mcpServer.userId, userId));
  return {
    plan: summary.plan === "pro_monthly" ? "pro_monthly" : "free",
    used: rows[0]?.value ?? 0,
    limit: unlimited ? null : FREE_TIER_MCP_SERVER_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// Connect flow
// ---------------------------------------------------------------------------

export type StartConnectionResult =
  | { type: "connected"; server: McpServerDto }
  | { type: "authorization_required"; authorizationUrl: string; expiresAt: string };

/**
 * Inserts a new server row, enforcing the plan limit inside the same SQL
 * statement so concurrent requests cannot overshoot the free-tier limit.
 */
async function insertServerWithLimit(
  db: DB,
  options: {
    userId: string;
    name: string;
    url: string;
    status: string;
    authType: string;
    encryptedAuth?: string | null;
    serverName?: string | null;
    serverVersion?: string | null;
  },
  limit: number | null,
) {
  const id = createId("mcpsrv");

  if (limit === null) {
    await db.insert(mcpServer).values({ id, ...options });
  } else {
    await db.insert(mcpServer).select(
      db
        .select({
          id: sql<string>`${id}`.as("id"),
          userId: sql<string>`${options.userId}`.as("user_id"),
          name: sql<string>`${options.name}`.as("name"),
          url: sql<string>`${options.url}`.as("url"),
          status: sql<string>`${options.status}`.as("status"),
          authType: sql<string>`${options.authType}`.as("auth_type"),
          encryptedAuth: sql<string | null>`${options.encryptedAuth ?? null}`.as("encrypted_auth"),
          serverName: sql<string | null>`${options.serverName ?? null}`.as("server_name"),
          serverVersion: sql<string | null>`${options.serverVersion ?? null}`.as("server_version"),
          lastError: sql<string | null>`${null}`.as("last_error"),
          lastTestedAt: sql<number | null>`${null}`.as("last_tested_at"),
          createdAt: sql<Date>`(unixepoch())`.as("created_at"),
          updatedAt: sql<Date>`(unixepoch())`.as("updated_at"),
        })
        .from(user)
        .where(
          and(
            eq(user.id, options.userId),
            lt(
              sql`(select count(*) from ${mcpServer} where ${mcpServer.userId} = ${options.userId})`,
              limit,
            ),
          ),
        ),
    );
  }

  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, id), eq(mcpServer.userId, options.userId)),
  });
  if (!row) {
    if (limit !== null) throw new McpServerLimitError(limit);
    throw new Error("Unable to save MCP server");
  }
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("UNIQUE constraint failed") ||
      error.message.includes("constraint failed"))
  );
}

async function beginOAuthTransaction(
  env: McpCoreEnv,
  userId: string,
  options: {
    serverUrl: URL;
    normalizedUrl: string;
    name: string;
    serverId?: string;
    wwwAuthenticate: string | null;
    origin: string;
  },
): Promise<StartConnectionResult> {
  const db = getDb(env.DB);
  const metadata = await discoverOAuthServer(options.serverUrl, options.wwwAuthenticate);
  if (!metadata.registrationEndpoint) {
    throw new ApiError(
      400,
      "This server does not support automatic client registration and cannot be connected",
    );
  }

  const redirectUri = new URL("/api/mcp/oauth/callback", options.origin).toString();
  const client = await registerClient(metadata.registrationEndpoint, redirectUri, "Tendon MCP");
  const pkce = await generatePkce();
  const transactionId = createId("mcptx");
  const expiresAt = new Date(Date.now() + OAUTH_TRANSACTION_TTL_MS);

  const payload: OauthTransactionPayload = {
    serverUrl: options.normalizedUrl,
    name: options.name,
    serverId: options.serverId,
    metadata,
    client,
    codeVerifier: pkce.verifier,
    redirectUri,
  };

  // Best-effort cleanup of stale transactions for this user.
  await db
    .delete(mcpOauthTransaction)
    .where(
      and(eq(mcpOauthTransaction.userId, userId), lt(mcpOauthTransaction.expiresAt, new Date())),
    );

  await db.insert(mcpOauthTransaction).values({
    id: transactionId,
    userId,
    serverUrl: options.normalizedUrl,
    serverName: options.name,
    encryptedPayload: await encryptJson(env, payload),
    expiresAt,
  });

  return {
    type: "authorization_required",
    authorizationUrl: buildAuthorizationUrl(metadata, {
      clientId: client.clientId,
      redirectUri,
      state: transactionId,
      codeChallenge: pkce.challenge,
    }),
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Starts the "add MCP server" flow: validates the URL, probes the server and
 * either stores it directly (no auth required) or opens an OAuth transaction.
 */
export async function startConnection(
  env: McpCoreEnv,
  userId: string,
  origin: string,
  input: { name: unknown; url: unknown },
): Promise<StartConnectionResult> {
  const name = validateServerName(input.name);
  if (typeof input.url !== "string") throw new ApiError(400, "Enter the server URL");
  const serverUrl = parsePublicHttpUrl(input.url);
  const normalizedUrl = normalizeServerUrl(serverUrl);

  const db = getDb(env.DB);
  const existing = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.userId, userId), eq(mcpServer.url, normalizedUrl)),
  });
  if (existing) {
    throw new ApiError(409, "This server is already connected. Edit or reconnect it instead.");
  }

  await assertPubliclyResolvable(serverUrl);

  let serverInfo: { name?: string; version?: string };
  try {
    serverInfo = await initializeServer(serverUrl);
  } catch (error) {
    if (error instanceof McpAuthRequiredError) {
      return beginOAuthTransaction(env, userId, {
        serverUrl,
        normalizedUrl,
        name,
        wwwAuthenticate: error.wwwAuthenticate,
        origin,
      });
    }
    if (error instanceof McpRemoteError) {
      throw new ApiError(400, `Could not connect to the MCP server: ${error.message}`);
    }
    if (error instanceof McpDiscoveryError) {
      throw new ApiError(400, `OAuth discovery failed: ${error.message}`);
    }
    throw error;
  }

  const quota = await getServerQuota(env, userId);
  try {
    const row = await insertServerWithLimit(
      db,
      {
        userId,
        name,
        url: normalizedUrl,
        status: "connected",
        authType: "none",
        serverName: serverInfo.name ?? null,
        serverVersion: serverInfo.version ?? null,
      },
      quota.limit,
    );
    return { type: "connected", server: toDto(row) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "This server is already connected. Edit or reconnect it instead.");
    }
    throw error;
  }
}

/**
 * Completes the OAuth redirect: exchanges the code, encrypts the tokens and
 * stores (or updates, when reconnecting) the server row.
 */
export async function completeOAuthCallback(
  env: McpCoreEnv,
  userId: string,
  input: { code: string; state: string },
): Promise<McpServerDto> {
  const db = getDb(env.DB);
  const transaction = await db.query.mcpOauthTransaction.findFirst({
    where: and(eq(mcpOauthTransaction.id, input.state), eq(mcpOauthTransaction.userId, userId)),
  });

  if (!transaction) {
    throw new ApiError(400, "Authorization session not found or already used. Please try again.");
  }

  // One-time use: consume the transaction before touching the network so a
  // leaked callback URL cannot be replayed.
  await db
    .delete(mcpOauthTransaction)
    .where(and(eq(mcpOauthTransaction.id, transaction.id), eq(mcpOauthTransaction.userId, userId)));

  if (transaction.expiresAt.getTime() < Date.now()) {
    throw new ApiError(400, "Authorization session expired. Please try again.");
  }

  let payload: OauthTransactionPayload;
  try {
    payload = await decryptJson<OauthTransactionPayload>(env, transaction.encryptedPayload);
  } catch {
    throw new ApiError(400, "Authorization session could not be read. Please try again.");
  }

  const tokens = await exchangeAuthorizationCode(payload.metadata, {
    code: input.code,
    redirectUri: payload.redirectUri,
    clientId: payload.client.clientId,
    clientSecret: payload.client.clientSecret,
    codeVerifier: payload.codeVerifier,
  }).catch((error: unknown) => {
    if (error instanceof McpRemoteError) {
      throw new ApiError(400, `The server rejected the authorization: ${error.message}`);
    }
    throw error;
  });

  const storedAuth: StoredAuth = {
    tokenEndpoint: payload.metadata.tokenEndpoint,
    clientId: payload.client.clientId,
    clientSecret: payload.client.clientSecret,
    tokens,
  };
  const encryptedAuth = await encryptJson(env, storedAuth);

  // Fetch server metadata with the fresh token; failure here does not abort
  // the flow because the tokens themselves are valid.
  let serverInfo: { name?: string; version?: string } = {};
  let status: McpServerStatus = "connected";
  let lastError: string | null = null;
  try {
    serverInfo = await initializeServer(new URL(payload.serverUrl), tokens.accessToken);
  } catch (error) {
    status = "error";
    lastError = sanitizeForLog(
      error instanceof Error ? error.message : "Post-authorization check failed",
    );
  }

  if (payload.serverId) {
    const updated = await db
      .update(mcpServer)
      .set({
        status,
        authType: "oauth",
        encryptedAuth,
        serverName: serverInfo.name ?? null,
        serverVersion: serverInfo.version ?? null,
        lastError,
        lastTestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(mcpServer.id, payload.serverId), eq(mcpServer.userId, userId)))
      .returning();
    const row = updated[0];
    if (!row) throw new ApiError(404, "The server was removed while authorizing");
    return toDto(row);
  }

  // Fresh connection: upsert if the row appeared while the user was away,
  // otherwise insert with a fresh limit check (things may have changed
  // between starting and completing the flow).
  const existing = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.userId, userId), eq(mcpServer.url, payload.serverUrl)),
  });
  if (existing) {
    const updated = await db
      .update(mcpServer)
      .set({
        status,
        authType: "oauth",
        encryptedAuth,
        serverName: serverInfo.name ?? null,
        serverVersion: serverInfo.version ?? null,
        lastError,
        lastTestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(mcpServer.id, existing.id), eq(mcpServer.userId, userId)))
      .returning();
    return toDto(updated[0]);
  }

  const quota = await getServerQuota(env, userId);
  try {
    const row = await insertServerWithLimit(
      db,
      {
        userId,
        name: payload.name,
        url: payload.serverUrl,
        status,
        authType: "oauth",
        encryptedAuth,
        serverName: serverInfo.name ?? null,
        serverVersion: serverInfo.version ?? null,
      },
      quota.limit,
    );
    return toDto(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "This server is already connected.");
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Row-level actions (test / edit / reconnect / disconnect)
// ---------------------------------------------------------------------------

async function getOwnedServer(db: DB, userId: string, serverId: string) {
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  if (!row) throw new ApiError(404, "MCP server not found");
  return row;
}

async function markAuthRequired(db: DB, serverId: string, message: string) {
  await db
    .update(mcpServer)
    .set({
      status: "requires_auth",
      lastError: sanitizeForLog(message),
      lastTestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mcpServer.id, serverId));
}

/**
 * Returns a usable access token, refreshing it when expired. Throws 401-style
 * ApiError when the user must re-authenticate.
 */
async function getValidAccessToken(
  env: McpCoreEnv,
  db: DB,
  row: typeof mcpServer.$inferSelect,
): Promise<string | undefined> {
  if (row.authType === "none") return undefined;
  if (!row.encryptedAuth) {
    throw new ApiError(400, "This server needs to be reconnected before it can be used");
  }

  let storedAuth: StoredAuth;
  try {
    storedAuth = await decryptJson<StoredAuth>(env, row.encryptedAuth);
  } catch {
    throw new ApiError(500, "Stored credentials could not be read. Reconnect the server.");
  }

  const expiresSoon =
    typeof storedAuth.tokens.expiresAt === "number" &&
    storedAuth.tokens.expiresAt - TOKEN_EXPIRY_SKEW_MS < Date.now();

  if (!expiresSoon) return storedAuth.tokens.accessToken;
  if (!storedAuth.tokens.refreshToken) return storedAuth.tokens.accessToken;

  try {
    const refreshed = await refreshAccessToken(storedAuth.tokenEndpoint, {
      refreshToken: storedAuth.tokens.refreshToken,
      clientId: storedAuth.clientId,
      clientSecret: storedAuth.clientSecret,
    });
    const nextAuth: StoredAuth = {
      ...storedAuth,
      tokens: {
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? storedAuth.tokens.refreshToken,
      },
    };
    await db
      .update(mcpServer)
      .set({ encryptedAuth: await encryptJson(env, nextAuth), updatedAt: new Date() })
      .where(eq(mcpServer.id, row.id));
    return refreshed.accessToken;
  } catch (error) {
    await markAuthRequired(
      db,
      row.id,
      error instanceof Error ? error.message : "Token refresh failed",
    );
    throw new ApiError(401, "Authorization expired. Reconnect the server.");
  }
}

export interface TestServerResult {
  ok: boolean;
  toolCount: number;
  serverName: string | null;
  serverVersion: string | null;
}

export async function testServer(
  env: McpCoreEnv,
  userId: string,
  serverId: string,
): Promise<TestServerResult> {
  const db = getDb(env.DB);
  const row = await getOwnedServer(db, userId, serverId);

  let accessToken: string | undefined;
  try {
    accessToken = await getValidAccessToken(env, db, row);
    const info = await initializeServer(new URL(row.url), accessToken);
    const { toolCount } = await listTools(new URL(row.url), accessToken);

    await db
      .update(mcpServer)
      .set({
        status: "connected",
        serverName: info.name ?? null,
        serverVersion: info.version ?? null,
        lastError: null,
        lastTestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(mcpServer.id, row.id));

    return {
      ok: true,
      toolCount,
      serverName: info.name ?? null,
      serverVersion: info.version ?? null,
    };
  } catch (error) {
    if (error instanceof McpAuthRequiredError) {
      await markAuthRequired(db, row.id, "The server rejected the stored credentials");
      throw new ApiError(401, "The server rejected the stored credentials. Reconnect it.");
    }
    if (error instanceof ApiError) throw error;
    const message = sanitizeForLog(
      error instanceof Error ? error.message : "Connection test failed",
    );
    await db
      .update(mcpServer)
      .set({ status: "error", lastError: message, lastTestedAt: new Date(), updatedAt: new Date() })
      .where(eq(mcpServer.id, row.id));
    throw new ApiError(502, `Connection test failed: ${message}`);
  }
}

export async function updateServer(
  env: McpCoreEnv,
  userId: string,
  serverId: string,
  input: { name?: unknown; url?: unknown },
): Promise<McpServerDto> {
  const db = getDb(env.DB);
  const row = await getOwnedServer(db, userId, serverId);

  const updates: Partial<typeof mcpServer.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    updates.name = validateServerName(input.name);
  }

  if (input.url !== undefined) {
    if (typeof input.url !== "string") throw new ApiError(400, "Enter the server URL");
    const nextUrl = parsePublicHttpUrl(input.url);
    const normalizedUrl = normalizeServerUrl(nextUrl);
    if (normalizedUrl !== row.url) {
      await assertPubliclyResolvable(nextUrl);
      const duplicate = await db.query.mcpServer.findFirst({
        where: and(eq(mcpServer.userId, userId), eq(mcpServer.url, normalizedUrl)),
      });
      if (duplicate && duplicate.id !== row.id) {
        throw new ApiError(409, "Another connected server already uses this URL");
      }
      // Tokens are bound to the resource origin, so a URL change always
      // invalidates stored credentials.
      updates.url = normalizedUrl;
      updates.encryptedAuth = null;
      updates.status = "requires_auth";
      updates.lastError = "Server URL changed — reconnect to authorize again";
      updates.serverName = null;
      updates.serverVersion = null;
    }
  }

  try {
    const updated = await db
      .update(mcpServer)
      .set(updates)
      .where(and(eq(mcpServer.id, row.id), eq(mcpServer.userId, userId)))
      .returning();
    return toDto(updated[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "Another connected server already uses this URL");
    }
    throw error;
  }
}

/**
 * Re-runs the connection flow for an existing row: probes the server and
 * either marks it connected (no auth) or opens a new OAuth transaction that
 * will update the same row on completion.
 */
export async function reconnectServer(
  env: McpCoreEnv,
  userId: string,
  origin: string,
  serverId: string,
): Promise<StartConnectionResult> {
  const db = getDb(env.DB);
  const row = await getOwnedServer(db, userId, serverId);
  const serverUrl = parsePublicHttpUrl(row.url);
  await assertPubliclyResolvable(serverUrl);

  try {
    const info = await initializeServer(serverUrl);
    await db
      .update(mcpServer)
      .set({
        status: "connected",
        authType: "none",
        encryptedAuth: null,
        serverName: info.name ?? null,
        serverVersion: info.version ?? null,
        lastError: null,
        lastTestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(mcpServer.id, row.id), eq(mcpServer.userId, userId)));
    const updated = await getOwnedServer(db, userId, serverId);
    return { type: "connected", server: toDto(updated) };
  } catch (error) {
    if (error instanceof McpAuthRequiredError) {
      return beginOAuthTransaction(env, userId, {
        serverUrl,
        normalizedUrl: row.url,
        name: row.name,
        serverId: row.id,
        wwwAuthenticate: error.wwwAuthenticate,
        origin,
      });
    }
    if (error instanceof McpRemoteError) {
      throw new ApiError(502, `Could not reach the server: ${error.message}`);
    }
    if (error instanceof McpDiscoveryError) {
      throw new ApiError(400, `OAuth discovery failed: ${error.message}`);
    }
    throw error;
  }
}

export async function deleteServer(env: McpCoreEnv, userId: string, serverId: string) {
  const db = getDb(env.DB);
  await getOwnedServer(db, userId, serverId);
  await db.delete(mcpServer).where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));
  return { deleted: true };
}
