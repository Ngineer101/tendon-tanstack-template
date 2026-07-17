import { and, desc, eq, lt, sql } from "drizzle-orm";

import { getDb, type DB } from "#/db";
import { mcpAuthSession, mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import type { BillingEnv } from "#/lib/billing/config.server";
import { hasEntitlement } from "#/lib/billing/core.server";
import {
  MCP_ERROR_CODES,
  MCP_FREE_SERVER_LIMIT,
  MCP_SERVER_NAME_MAX_LENGTH,
  type McpServerInfo,
  type McpServerSummary,
} from "./config";
import { decryptJson, encryptJson, importEncryptionKey } from "./crypto.server";
import {
  buildAuthorizationUrl,
  createOauthState,
  createPkcePair,
  discoverOauthEndpoints,
  exchangeAuthorizationCode,
  probeMcpServer,
  refreshAccessToken,
  registerOauthClient,
  type McpAuthData,
  type McpOauthConfig,
} from "./oauth.server";
import { assertSafeExternalUrl, type UrlSecurityOptions } from "./url-security.server";

export interface McpEnv extends Cloudflare.Env {
  MCP_TOKEN_ENCRYPTION_KEY?: string;
  MCP_ALLOW_INSECURE_LOCALHOST?: string;
}

// Dependencies for the MCP domain logic, kept injectable so tests can run
// against an in-memory SQLite database and a stubbed entitlement check.
export interface McpContext {
  db: DB;
  encryptionSecret: string | undefined;
  urlOptions: UrlSecurityOptions;
  isUnlimited(userId: string): Promise<boolean>;
}

export function createMcpContext(env: McpEnv & BillingEnv): McpContext {
  return {
    db: getDb(env.DB),
    encryptionSecret: env.MCP_TOKEN_ENCRYPTION_KEY,
    urlOptions: { allowInsecureLocalhost: env.MCP_ALLOW_INSECURE_LOCALHOST === "true" },
    isUnlimited: (userId) => hasEntitlement(env, userId, "unlimited_mcp_servers"),
  };
}

export class McpServerLimitError extends ApiError {
  constructor() {
    super(403, `Free accounts can connect up to ${MCP_FREE_SERVER_LIMIT} MCP servers`, {
      code: MCP_ERROR_CODES.limitReached,
      limit: MCP_FREE_SERVER_LIMIT,
    });
    this.name = "McpServerLimitError";
  }
}

const AUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const TOKEN_EXPIRY_LEEWAY_MS = 30 * 1000;

type McpServerRow = typeof mcpServer.$inferSelect;

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function validateServerName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name || name.length > MCP_SERVER_NAME_MAX_LENGTH) {
    throw new ApiError(400, `Name must be 1-${MCP_SERVER_NAME_MAX_LENGTH} characters`);
  }
  return name;
}

function parseJsonColumn<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function mapUniqueViolation(error: unknown): never {
  // Drivers wrap the SQLite error (e.g. DrizzleError -> SqliteError), so walk
  // the cause chain looking for the constraint message.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.message.includes("UNIQUE constraint failed")) {
      throw new ApiError(409, "This MCP server is already connected", {
        code: MCP_ERROR_CODES.duplicateServer,
      });
    }
    current = current.cause;
  }
  throw error;
}

export function sanitizeServer(row: McpServerRow): McpServerSummary {
  return {
    id: row.id,
    name: row.name,
    serverUrl: row.serverUrl,
    status: row.status as McpServerSummary["status"],
    authType: row.authType as McpServerSummary["authType"],
    serverInfo: parseJsonColumn<McpServerInfo>(row.serverInfo),
    lastError: row.lastError,
    lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function countServersForUser(db: DB, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mcpServer)
    .where(eq(mcpServer.userId, userId));
  return row?.count ?? 0;
}

export function listServersForUser(db: DB, userId: string) {
  return db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    orderBy: [desc(mcpServer.createdAt), desc(mcpServer.id)],
  });
}

export async function getServerForUser(
  db: DB,
  userId: string,
  serverId: string,
): Promise<McpServerRow> {
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  if (!row) {
    throw new ApiError(404, "MCP server not found");
  }
  return row;
}

interface InsertServerInput {
  userId: string;
  unlimited: boolean;
  name: string;
  serverUrl: string;
  status: string;
  authType: string;
  oauthConfig: string | null;
  authData: string | null;
  serverInfo: string | null;
  lastConnectedAt: Date | null;
}

// Inserts a server while atomically enforcing the free-plan limit: the guarded
// INSERT ... SELECT only inserts when the user's current count is below the
// limit, so concurrent requests cannot overshoot it.
export async function insertServerWithLimit(db: DB, input: InsertServerInput) {
  const id = createId("mcp");
  const lastConnectedAt = input.lastConnectedAt
    ? Math.floor(input.lastConnectedAt.getTime() / 1000)
    : null;

  try {
    if (input.unlimited) {
      await db.insert(mcpServer).values({
        id,
        userId: input.userId,
        name: input.name,
        serverUrl: input.serverUrl,
        status: input.status,
        authType: input.authType,
        oauthConfig: input.oauthConfig,
        authData: input.authData,
        serverInfo: input.serverInfo,
        lastConnectedAt: input.lastConnectedAt,
        lastCheckedAt: input.lastConnectedAt,
      });
    } else {
      await db.run(sql`
        INSERT INTO mcp_server (
          id, user_id, name, server_url, status, auth_type,
          oauth_config, auth_data, server_info, last_connected_at, last_checked_at
        )
        SELECT ${id}, ${input.userId}, ${input.name}, ${input.serverUrl}, ${input.status},
          ${input.authType}, ${input.oauthConfig}, ${input.authData}, ${input.serverInfo},
          ${lastConnectedAt}, ${lastConnectedAt}
        WHERE (
          SELECT COUNT(*) FROM mcp_server WHERE user_id = ${input.userId}
        ) < ${MCP_FREE_SERVER_LIMIT}
      `);
    }
  } catch (error) {
    mapUniqueViolation(error);
  }

  const row = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
  if (!row) {
    throw new McpServerLimitError();
  }
  return row;
}

async function updateServerRow(db: DB, serverId: string, patch: Partial<McpServerRow>) {
  await db
    .update(mcpServer)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(mcpServer.id, serverId));
  const row = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, serverId) });
  if (!row) {
    throw new ApiError(404, "MCP server not found");
  }
  return row;
}

export async function createAuthSession(
  ctx: McpContext,
  server: McpServerRow,
  config: McpOauthConfig,
  origin: string,
): Promise<string> {
  const key = await importEncryptionKey(ctx.encryptionSecret);
  const state = createOauthState();
  const pkce = await createPkcePair();

  // One pending flow per server; also sweep this user's expired sessions.
  await ctx.db.delete(mcpAuthSession).where(eq(mcpAuthSession.serverId, server.id));
  await ctx.db
    .delete(mcpAuthSession)
    .where(and(eq(mcpAuthSession.userId, server.userId), lt(mcpAuthSession.expiresAt, new Date())));

  await ctx.db.insert(mcpAuthSession).values({
    state,
    serverId: server.id,
    userId: server.userId,
    codeVerifier: await encryptJson(key, pkce.verifier),
    expiresAt: new Date(Date.now() + AUTH_SESSION_TTL_MS),
  });

  return buildAuthorizationUrl(config, {
    redirectUri: oauthRedirectUri(origin),
    state,
    codeChallenge: pkce.challenge,
  });
}

export async function consumeAuthSession(db: DB, state: string) {
  const session = await db.query.mcpAuthSession.findFirst({
    where: eq(mcpAuthSession.state, state),
  });
  if (!session) return null;
  await db.delete(mcpAuthSession).where(eq(mcpAuthSession.state, state));
  if (session.expiresAt.getTime() < Date.now()) return null;
  return session;
}

export function oauthRedirectUri(origin: string) {
  return `${origin}/api/mcp/oauth/callback`;
}

export async function listServersWithUsage(ctx: McpContext, userId: string) {
  const [rows, unlimited] = await Promise.all([
    listServersForUser(ctx.db, userId),
    ctx.isUnlimited(userId),
  ]);
  return {
    servers: rows.map(sanitizeServer),
    usage: {
      used: rows.length,
      limit: unlimited ? null : MCP_FREE_SERVER_LIMIT,
      unlimited,
    },
  };
}

// Sets up OAuth for a server that answered 401: discovery, dynamic client
// registration, encrypted secret storage, and a pending authorization session.
async function prepareOauth(
  ctx: McpContext,
  serverUrl: URL,
  wwwAuthenticate: string | null,
  origin: string,
): Promise<{ oauthConfig: McpOauthConfig; encryptedAuthData: string }> {
  const key = await importEncryptionKey(ctx.encryptionSecret);
  const endpoints = await discoverOauthEndpoints(serverUrl, wwwAuthenticate, ctx.urlOptions);
  const client = await registerOauthClient(endpoints, oauthRedirectUri(origin), ctx.urlOptions);
  const oauthConfig: McpOauthConfig = { ...endpoints, clientId: client.clientId };
  const authData: McpAuthData = client.clientSecret ? { clientSecret: client.clientSecret } : {};
  return { oauthConfig, encryptedAuthData: await encryptJson(key, authData) };
}

export interface BeginConnectionResult {
  server: McpServerSummary;
  authorizationUrl: string | null;
}

export async function beginServerConnection(
  ctx: McpContext,
  userId: string,
  input: { name?: unknown; serverUrl?: unknown },
  origin: string,
): Promise<BeginConnectionResult> {
  const name = validateServerName(input.name);
  if (typeof input.serverUrl !== "string") {
    throw new ApiError(400, "Enter a valid URL, e.g. https://mcp.example.com/mcp");
  }
  const serverUrl = assertSafeExternalUrl(input.serverUrl, ctx.urlOptions);

  const unlimited = await ctx.isUnlimited(userId);
  if (!unlimited && (await countServersForUser(ctx.db, userId)) >= MCP_FREE_SERVER_LIMIT) {
    throw new McpServerLimitError();
  }

  const probe = await probeMcpServer(serverUrl, null, ctx.urlOptions);
  if (probe.kind === "error") {
    throw new ApiError(502, `Could not connect: ${probe.message}`);
  }

  if (probe.kind === "ok") {
    const row = await insertServerWithLimit(ctx.db, {
      userId,
      unlimited,
      name,
      serverUrl: serverUrl.toString(),
      status: "connected",
      authType: "none",
      oauthConfig: null,
      authData: null,
      serverInfo: probe.serverInfo ? JSON.stringify(probe.serverInfo) : null,
      lastConnectedAt: new Date(),
    });
    return { server: sanitizeServer(row), authorizationUrl: null };
  }

  const { oauthConfig, encryptedAuthData } = await prepareOauth(
    ctx,
    serverUrl,
    probe.wwwAuthenticate,
    origin,
  );
  const row = await insertServerWithLimit(ctx.db, {
    userId,
    unlimited,
    name,
    serverUrl: serverUrl.toString(),
    status: "needs_auth",
    authType: "oauth",
    oauthConfig: JSON.stringify(oauthConfig),
    authData: encryptedAuthData,
    serverInfo: null,
    lastConnectedAt: null,
  });
  const authorizationUrl = await createAuthSession(ctx, row, oauthConfig, origin);
  return { server: sanitizeServer(row), authorizationUrl };
}

export async function startReconnect(
  ctx: McpContext,
  userId: string,
  serverId: string,
  origin: string,
): Promise<BeginConnectionResult> {
  const row = await getServerForUser(ctx.db, userId, serverId);
  const serverUrl = assertSafeExternalUrl(row.serverUrl, ctx.urlOptions);

  const probe = await probeMcpServer(serverUrl, null, ctx.urlOptions);
  if (probe.kind === "error") {
    await updateServerRow(ctx.db, row.id, {
      status: "error",
      lastError: probe.message,
      lastCheckedAt: new Date(),
    });
    throw new ApiError(502, `Could not connect: ${probe.message}`);
  }

  if (probe.kind === "ok") {
    // The server is reachable without credentials again.
    const updated = await updateServerRow(ctx.db, row.id, {
      status: "connected",
      authType: "none",
      serverInfo: probe.serverInfo ? JSON.stringify(probe.serverInfo) : row.serverInfo,
      lastError: null,
      lastConnectedAt: new Date(),
      lastCheckedAt: new Date(),
    });
    return { server: sanitizeServer(updated), authorizationUrl: null };
  }

  let config = parseJsonColumn<McpOauthConfig>(row.oauthConfig);
  let current = row;
  if (!config?.clientId) {
    const prepared = await prepareOauth(ctx, serverUrl, probe.wwwAuthenticate, origin);
    config = prepared.oauthConfig;
    current = await updateServerRow(ctx.db, row.id, {
      authType: "oauth",
      oauthConfig: JSON.stringify(prepared.oauthConfig),
      authData: prepared.encryptedAuthData,
    });
  }

  const authorizationUrl = await createAuthSession(ctx, current, config, origin);
  return { server: sanitizeServer(current), authorizationUrl };
}

export async function completeOauthCallback(
  ctx: McpContext,
  userId: string,
  params: { state: string | null; code: string | null; error: string | null },
  origin: string,
): Promise<McpServerSummary> {
  if (!params.state) {
    throw new ApiError(400, "The authorization response is missing its state parameter");
  }

  const session = await consumeAuthSession(ctx.db, params.state);
  if (!session) {
    throw new ApiError(400, "This authorization link has expired or was already used");
  }
  if (session.userId !== userId) {
    throw new ApiError(403, "This authorization link belongs to a different account");
  }

  const server = await getServerForUser(ctx.db, session.userId, session.serverId);

  if (params.error || !params.code) {
    await updateServerRow(ctx.db, server.id, {
      status: "needs_auth",
      lastError: params.error === "access_denied" ? "Authorization was declined" : null,
    });
    throw new ApiError(
      400,
      params.error === "access_denied"
        ? "Authorization was declined on the server's consent screen"
        : "The authorization server returned an error",
    );
  }

  const config = parseJsonColumn<McpOauthConfig>(server.oauthConfig);
  if (!config) {
    throw new ApiError(500, "This server is missing its OAuth configuration; reconnect it");
  }

  const key = await importEncryptionKey(ctx.encryptionSecret);
  const storedAuth = server.authData
    ? await decryptJson<McpAuthData>(key, server.authData)
    : ({} as McpAuthData);
  const codeVerifier = await decryptJson<string>(key, session.codeVerifier);

  const tokens = await exchangeAuthorizationCode(
    config,
    {
      code: params.code,
      codeVerifier,
      redirectUri: oauthRedirectUri(origin),
      clientSecret: storedAuth.clientSecret ?? null,
    },
    ctx.urlOptions,
  );

  const serverUrl = assertSafeExternalUrl(server.serverUrl, ctx.urlOptions);
  const probe = await probeMcpServer(serverUrl, tokens.accessToken, ctx.urlOptions);

  const updated = await updateServerRow(ctx.db, server.id, {
    authData: await encryptJson(key, { ...storedAuth, tokens } satisfies McpAuthData),
    status: probe.kind === "ok" ? "connected" : "error",
    serverInfo:
      probe.kind === "ok" && probe.serverInfo
        ? JSON.stringify(probe.serverInfo)
        : server.serverInfo,
    lastError:
      probe.kind === "ok"
        ? null
        : probe.kind === "unauthorized"
          ? "The server rejected the newly issued access token"
          : probe.message,
    lastConnectedAt: probe.kind === "ok" ? new Date() : server.lastConnectedAt,
    lastCheckedAt: new Date(),
  });
  return sanitizeServer(updated);
}

// Returns a working access token for an OAuth server, refreshing (and
// re-encrypting) it when it is expired. Returns null when reauthorization is
// required.
async function resolveAccessToken(ctx: McpContext, row: McpServerRow): Promise<string | null> {
  if (row.authType !== "oauth") return null;
  if (!row.authData) return null;

  const key = await importEncryptionKey(ctx.encryptionSecret);
  const authData = await decryptJson<McpAuthData>(key, row.authData);
  const tokens = authData.tokens;
  if (!tokens?.accessToken) return null;

  const expired =
    tokens.expiresAt !== null && tokens.expiresAt < Date.now() + TOKEN_EXPIRY_LEEWAY_MS;
  if (!expired) return tokens.accessToken;

  const config = parseJsonColumn<McpOauthConfig>(row.oauthConfig);
  if (!tokens.refreshToken || !config) return null;

  try {
    const refreshed = await refreshAccessToken(
      config,
      { refreshToken: tokens.refreshToken, clientSecret: authData.clientSecret ?? null },
      ctx.urlOptions,
    );
    const merged = {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    };
    await updateServerRow(ctx.db, row.id, {
      authData: await encryptJson(key, { ...authData, tokens: merged } satisfies McpAuthData),
    });
    return merged.accessToken;
  } catch {
    // Refresh failures require the user to reauthorize; details are not logged
    // to avoid leaking token material.
    return null;
  }
}

export async function testServerConnection(
  ctx: McpContext,
  userId: string,
  serverId: string,
): Promise<McpServerSummary> {
  const row = await getServerForUser(ctx.db, userId, serverId);
  const now = new Date();

  let accessToken: string | null = null;
  if (row.authType === "oauth") {
    accessToken = await resolveAccessToken(ctx, row);
    if (!accessToken) {
      const updated = await updateServerRow(ctx.db, row.id, {
        status: "needs_auth",
        lastError: "Authorization expired. Reconnect to continue.",
        lastCheckedAt: now,
      });
      return sanitizeServer(updated);
    }
  }

  const serverUrl = assertSafeExternalUrl(row.serverUrl, ctx.urlOptions);
  const probe = await probeMcpServer(serverUrl, accessToken, ctx.urlOptions);

  const patch: Partial<McpServerRow> =
    probe.kind === "ok"
      ? {
          status: "connected",
          serverInfo: probe.serverInfo ? JSON.stringify(probe.serverInfo) : row.serverInfo,
          lastError: null,
          lastConnectedAt: now,
          lastCheckedAt: now,
        }
      : probe.kind === "unauthorized"
        ? {
            status: "needs_auth",
            lastError:
              row.authType === "oauth"
                ? "The server rejected the stored credentials"
                : "The server now requires authorization",
            lastCheckedAt: now,
          }
        : { status: "error", lastError: probe.message, lastCheckedAt: now };

  const updated = await updateServerRow(ctx.db, row.id, patch);
  return sanitizeServer(updated);
}

export interface UpdateServerResult {
  server: McpServerSummary;
  authorizationUrl: string | null;
}

export async function updateServerDetails(
  ctx: McpContext,
  userId: string,
  serverId: string,
  input: { name?: unknown; serverUrl?: unknown },
  origin: string,
): Promise<UpdateServerResult> {
  const row = await getServerForUser(ctx.db, userId, serverId);
  const patch: Partial<McpServerRow> = {};

  if (input.name !== undefined) {
    patch.name = validateServerName(input.name);
  }

  let authorizationUrl: string | null = null;
  let pendingOauthConfig: McpOauthConfig | null = null;

  if (input.serverUrl !== undefined) {
    if (typeof input.serverUrl !== "string") {
      throw new ApiError(400, "Enter a valid URL, e.g. https://mcp.example.com/mcp");
    }
    const serverUrl = assertSafeExternalUrl(input.serverUrl, ctx.urlOptions);

    if (serverUrl.toString() !== row.serverUrl) {
      // A different URL is a different server: existing credentials are
      // discarded and the new endpoint is probed before saving.
      const probe = await probeMcpServer(serverUrl, null, ctx.urlOptions);
      if (probe.kind === "error") {
        throw new ApiError(502, `Could not connect: ${probe.message}`);
      }

      patch.serverUrl = serverUrl.toString();
      if (probe.kind === "ok") {
        patch.status = "connected";
        patch.authType = "none";
        patch.oauthConfig = null;
        patch.authData = null;
        patch.serverInfo = probe.serverInfo ? JSON.stringify(probe.serverInfo) : null;
        patch.lastError = null;
        patch.lastConnectedAt = new Date();
        patch.lastCheckedAt = new Date();
      } else {
        const prepared = await prepareOauth(ctx, serverUrl, probe.wwwAuthenticate, origin);
        pendingOauthConfig = prepared.oauthConfig;
        patch.status = "needs_auth";
        patch.authType = "oauth";
        patch.oauthConfig = JSON.stringify(prepared.oauthConfig);
        patch.authData = prepared.encryptedAuthData;
        patch.serverInfo = null;
        patch.lastError = null;
      }
    }
  }

  if (Object.keys(patch).length === 0) {
    return { server: sanitizeServer(row), authorizationUrl: null };
  }

  let updated: McpServerRow;
  try {
    updated = await updateServerRow(ctx.db, row.id, patch);
  } catch (error) {
    mapUniqueViolation(error);
  }

  if (pendingOauthConfig) {
    authorizationUrl = await createAuthSession(ctx, updated, pendingOauthConfig, origin);
  }
  return { server: sanitizeServer(updated), authorizationUrl };
}

export async function disconnectServer(
  ctx: McpContext,
  userId: string,
  serverId: string,
): Promise<void> {
  await getServerForUser(ctx.db, userId, serverId);
  // Encrypted tokens are destroyed with the row; pending auth sessions cascade.
  await ctx.db.delete(mcpServer).where(eq(mcpServer.id, serverId));
}

// For chat integrations: resolves the request headers needed to call a user's
// connected MCP server, refreshing the access token when necessary.
export async function getServerRequestConfig(
  ctx: McpContext,
  userId: string,
  serverId: string,
): Promise<{ url: string; headers: Record<string, string> }> {
  const row = await getServerForUser(ctx.db, userId, serverId);
  if (row.authType === "none") {
    return { url: row.serverUrl, headers: {} };
  }
  const accessToken = await resolveAccessToken(ctx, row);
  if (!accessToken) {
    throw new ApiError(409, "This MCP server needs to be reconnected");
  }
  return { url: row.serverUrl, headers: { authorization: `Bearer ${accessToken}` } };
}
