import { and, eq, lt, sql } from "drizzle-orm";

import type { DB } from "#/db";
import { mcpOauthSession, mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import {
  FREE_MCP_SERVER_LIMIT,
  MCP_SERVER_NAME_MAX_LENGTH,
  type McpServerInfo,
  type McpServerStatus,
  type PublicMcpServer,
} from "./config";
import { decryptSecret, encryptSecret } from "./crypto.server";
import {
  buildAuthorizationUrl,
  computeCodeChallenge,
  discoverOAuth,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  generateStateToken,
  refreshAccessToken,
  registerOAuthClient,
  revokeToken,
  type AuthorizationServerMetadata,
  type OAuthClient,
} from "./oauth.server";
import { probeMcpServer } from "./protocol.server";
import { assertSafeHttpUrl } from "./url-security.server";

// Network-touching collaborators are injectable so domain logic can be tested
// without real MCP servers or authorization servers.
export interface McpDeps {
  probe: typeof probeMcpServer;
  discover: typeof discoverOAuth;
  register: typeof registerOAuthClient;
  exchangeCode: typeof exchangeAuthorizationCode;
  refresh: typeof refreshAccessToken;
  revoke: typeof revokeToken;
}

export const defaultMcpDeps: McpDeps = {
  probe: probeMcpServer,
  discover: discoverOAuth,
  register: registerOAuthClient,
  exchangeCode: exchangeAuthorizationCode,
  refresh: refreshAccessToken,
  revoke: revokeToken,
};

const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_LEEWAY_MS = 60 * 1000;

type McpServerRow = typeof mcpServer.$inferSelect;

export class McpServerLimitError extends ApiError {
  constructor() {
    super(402, `The free plan allows up to ${FREE_MCP_SERVER_LIMIT} MCP servers`, {
      code: "mcp_server_limit",
      limit: FREE_MCP_SERVER_LIMIT,
    });
    this.name = "McpServerLimitError";
  }
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function toPublicMcpServer(row: McpServerRow): PublicMcpServer {
  let serverInfo: McpServerInfo | null = null;
  if (row.serverInfo) {
    try {
      serverInfo = JSON.parse(row.serverInfo) as McpServerInfo;
    } catch {
      serverInfo = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    status: row.status as McpServerStatus,
    authType: row.authType as PublicMcpServer["authType"],
    scope: row.scope,
    serverInfo,
    lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

function normalizeName(name: unknown) {
  if (typeof name !== "string" || !name.trim()) {
    throw new ApiError(400, "Server name is required");
  }
  const trimmed = name.trim();
  if (trimmed.length > MCP_SERVER_NAME_MAX_LENGTH) {
    throw new ApiError(400, `Server name must be ${MCP_SERVER_NAME_MAX_LENGTH} characters or less`);
  }
  return trimmed;
}

function normalizeUrl(url: unknown) {
  if (typeof url !== "string" || !url.trim()) {
    throw new ApiError(400, "Server URL is required");
  }
  const parsed = assertSafeHttpUrl(url, "Server URL");
  parsed.hash = "";
  return parsed.toString();
}

export async function listMcpServers(db: DB, userId: string) {
  return db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
  });
}

export async function countMcpServers(db: DB, userId: string) {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(mcpServer)
    .where(eq(mcpServer.userId, userId));
  return rows[0]?.count ?? 0;
}

async function getOwnedMcpServer(db: DB, userId: string, serverId: string) {
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  if (!row) {
    throw new ApiError(404, "MCP server not found");
  }
  return row;
}

export async function createMcpServer(
  db: DB,
  options: { userId: string; name: unknown; url: unknown; unlimited: boolean },
) {
  const name = normalizeName(options.name);
  const url = normalizeUrl(options.url);

  if (!options.unlimited && (await countMcpServers(db, options.userId)) >= FREE_MCP_SERVER_LIMIT) {
    throw new McpServerLimitError();
  }

  const id = createId("mcp");
  try {
    await db.insert(mcpServer).values({ id, userId: options.userId, name, url });
  } catch (error) {
    if (error instanceof Error && /unique/i.test(error.message)) {
      throw new ApiError(409, "This server is already in your workspace");
    }
    throw error;
  }

  // D1 offers no transactions here, so guard against a concurrent create
  // slipping past the pre-insert count with a compensating check.
  if (!options.unlimited && (await countMcpServers(db, options.userId)) > FREE_MCP_SERVER_LIMIT) {
    await db.delete(mcpServer).where(eq(mcpServer.id, id));
    throw new McpServerLimitError();
  }

  return getOwnedMcpServer(db, options.userId, id);
}

export async function updateMcpServer(
  db: DB,
  options: { userId: string; serverId: string; name?: unknown; url?: unknown },
) {
  const server = await getOwnedMcpServer(db, options.userId, options.serverId);
  const updates: Partial<typeof mcpServer.$inferInsert> = { updatedAt: new Date() };

  if (options.name !== undefined) {
    updates.name = normalizeName(options.name);
  }
  if (options.url !== undefined) {
    const url = normalizeUrl(options.url);
    if (url !== server.url) {
      const duplicate = await db.query.mcpServer.findFirst({
        where: and(eq(mcpServer.userId, options.userId), eq(mcpServer.url, url)),
      });
      if (duplicate) {
        throw new ApiError(409, "This server is already in your workspace");
      }
      // A different URL is a different server: all discovered auth state and
      // credentials become invalid.
      Object.assign(updates, {
        url,
        status: "pending_auth",
        authType: null,
        oauthIssuer: null,
        oauthMetadata: null,
        clientId: null,
        clientSecretEnc: null,
        accessTokenEnc: null,
        refreshTokenEnc: null,
        accessTokenExpiresAt: null,
        scope: null,
        serverInfo: null,
        lastConnectedAt: null,
        lastTestedAt: null,
        lastError: null,
      });
    }
  }

  const rows = await db
    .update(mcpServer)
    .set(updates)
    .where(eq(mcpServer.id, server.id))
    .returning();
  return rows[0]!;
}

interface AuthState {
  metadata: AuthorizationServerMetadata;
  client: OAuthClient;
}

async function getStoredAuthState(key: string, server: McpServerRow): Promise<AuthState> {
  if (!server.oauthMetadata || !server.clientId) {
    throw new ApiError(
      409,
      "This server connection is not set up for authorization — reconnect it first",
    );
  }
  let metadata: AuthorizationServerMetadata;
  try {
    metadata = JSON.parse(server.oauthMetadata) as AuthorizationServerMetadata;
  } catch {
    throw new ApiError(
      409,
      "This server connection is not set up for authorization — reconnect it first",
    );
  }
  return {
    metadata,
    client: {
      clientId: server.clientId,
      clientSecret: server.clientSecretEnc
        ? await decryptSecret(key, server.clientSecretEnc)
        : undefined,
    },
  };
}

export type McpConnectResult =
  | { kind: "connected"; server: McpServerRow }
  | { kind: "authorize"; authorizeUrl: string };

// Entry point for connect and reconnect: probes the server, and either marks
// it connected (no auth needed) or prepares an OAuth authorization redirect.
export async function beginMcpConnect(
  db: DB,
  key: string,
  options: { userId: string; serverId: string; origin: string },
  deps: McpDeps = defaultMcpDeps,
): Promise<McpConnectResult> {
  const server = await getOwnedMcpServer(db, options.userId, options.serverId);
  const now = new Date();

  const probe = await deps.probe(server.url);

  if (probe.ok) {
    const rows = await db
      .update(mcpServer)
      .set({
        status: "connected",
        authType: "none",
        serverInfo: JSON.stringify(probe.serverInfo),
        accessTokenEnc: null,
        refreshTokenEnc: null,
        accessTokenExpiresAt: null,
        scope: null,
        lastConnectedAt: now,
        lastTestedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(mcpServer.id, server.id))
      .returning();
    return { kind: "connected", server: rows[0]! };
  }

  if (probe.reason === "error") {
    await db
      .update(mcpServer)
      .set({ status: "error", lastError: probe.message, lastTestedAt: now, updatedAt: now })
      .where(eq(mcpServer.id, server.id));
    throw new ApiError(502, probe.message, { code: "mcp_unreachable" });
  }

  // The server demands OAuth. Discover its authorization server and make sure
  // we have a registered client, then hand the user off to authorize.
  let discovery;
  let client: OAuthClient;
  const redirectUri = `${options.origin}/api/mcp/oauth/callback`;
  try {
    discovery = await deps.discover(server.url, probe.wwwAuthenticate);
    const canReuseClient = server.clientId && server.oauthIssuer === discovery.authServer.issuer;
    client = canReuseClient
      ? {
          clientId: server.clientId!,
          clientSecret: server.clientSecretEnc
            ? await decryptSecret(key, server.clientSecretEnc)
            : undefined,
        }
      : await deps.register(discovery.authServer, {
          redirectUri,
          clientName: "Tendon TanStack Template",
        });
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : "OAuth discovery failed unexpectedly";
    await db
      .update(mcpServer)
      .set({ status: "error", lastError: message, lastTestedAt: now, updatedAt: now })
      .where(eq(mcpServer.id, server.id));
    throw error;
  }

  const codeVerifier = generateCodeVerifier();
  const state = generateStateToken();

  await db
    .update(mcpServer)
    .set({
      authType: "oauth",
      oauthIssuer: discovery.authServer.issuer,
      oauthMetadata: JSON.stringify(discovery.authServer),
      clientId: client.clientId,
      clientSecretEnc: client.clientSecret ? await encryptSecret(key, client.clientSecret) : null,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(mcpServer.id, server.id));

  // Opportunistically clear this user's expired authorization attempts.
  await db
    .delete(mcpOauthSession)
    .where(and(eq(mcpOauthSession.userId, options.userId), lt(mcpOauthSession.expiresAt, now)));

  await db.insert(mcpOauthSession).values({
    state,
    serverId: server.id,
    userId: options.userId,
    codeVerifierEnc: await encryptSecret(key, codeVerifier),
    redirectUri,
    resource: discovery.resource,
    expiresAt: new Date(now.getTime() + OAUTH_SESSION_TTL_MS),
  });

  const authorizeUrl = buildAuthorizationUrl(discovery.authServer, {
    clientId: client.clientId,
    redirectUri,
    state,
    codeChallenge: await computeCodeChallenge(codeVerifier),
    resource: discovery.resource,
    scope: discovery.scopes?.join(" ") || undefined,
  });

  return { kind: "authorize", authorizeUrl };
}

export async function completeMcpAuthorization(
  db: DB,
  key: string,
  options: { userId: string; state: string; code: string },
  deps: McpDeps = defaultMcpDeps,
) {
  const invalidState = new ApiError(400, "This authorization attempt is invalid or has expired", {
    code: "oauth_state_invalid",
  });

  const session = await db.query.mcpOauthSession.findFirst({
    where: eq(mcpOauthSession.state, options.state),
  });
  if (session) {
    // Single-use: consume the state before doing anything else.
    await db.delete(mcpOauthSession).where(eq(mcpOauthSession.state, session.state));
  }
  if (!session || session.userId !== options.userId || session.expiresAt < new Date()) {
    throw invalidState;
  }

  const server = await getOwnedMcpServer(db, options.userId, session.serverId);
  const { metadata, client } = await getStoredAuthState(key, server);
  const codeVerifier = await decryptSecret(key, session.codeVerifierEnc);

  const tokens = await deps.exchangeCode(metadata, {
    client,
    code: options.code,
    codeVerifier,
    redirectUri: session.redirectUri,
    resource: session.resource,
  });

  const now = new Date();
  const verification = await deps.probe(server.url, tokens.access_token);
  const status: McpServerStatus = verification.ok ? "connected" : "error";

  const rows = await db
    .update(mcpServer)
    .set({
      status,
      accessTokenEnc: await encryptSecret(key, tokens.access_token),
      refreshTokenEnc: tokens.refresh_token ? await encryptSecret(key, tokens.refresh_token) : null,
      accessTokenExpiresAt: tokens.expires_in
        ? new Date(now.getTime() + tokens.expires_in * 1000)
        : null,
      scope: tokens.scope ?? null,
      serverInfo: verification.ok ? JSON.stringify(verification.serverInfo) : server.serverInfo,
      lastConnectedAt: verification.ok ? now : server.lastConnectedAt,
      lastTestedAt: now,
      lastError: verification.ok
        ? null
        : "Authorized, but the MCP handshake failed — try testing the connection",
      updatedAt: now,
    })
    .where(eq(mcpServer.id, server.id))
    .returning();

  return rows[0]!;
}

async function getFreshAccessToken(
  db: DB,
  key: string,
  server: McpServerRow,
  deps: McpDeps,
): Promise<{ token: string } | { token: null; reauthReason: string }> {
  if (server.authType !== "oauth") return { token: null, reauthReason: "" };
  if (!server.accessTokenEnc) {
    return { token: null, reauthReason: "Authentication required" };
  }

  const expiresSoon =
    server.accessTokenExpiresAt &&
    server.accessTokenExpiresAt.getTime() - Date.now() < TOKEN_REFRESH_LEEWAY_MS;
  if (!expiresSoon) {
    return { token: await decryptSecret(key, server.accessTokenEnc) };
  }
  if (!server.refreshTokenEnc) {
    return { token: null, reauthReason: "Access expired — reconnect to continue" };
  }

  try {
    const { metadata, client } = await getStoredAuthState(key, server);
    const refreshToken = await decryptSecret(key, server.refreshTokenEnc);
    const tokens = await deps.refresh(metadata, {
      client,
      refreshToken,
      resource: server.url,
    });
    const now = new Date();
    await db
      .update(mcpServer)
      .set({
        accessTokenEnc: await encryptSecret(key, tokens.access_token),
        refreshTokenEnc: tokens.refresh_token
          ? await encryptSecret(key, tokens.refresh_token)
          : server.refreshTokenEnc,
        accessTokenExpiresAt: tokens.expires_in
          ? new Date(now.getTime() + tokens.expires_in * 1000)
          : null,
        updatedAt: now,
      })
      .where(eq(mcpServer.id, server.id));
    return { token: tokens.access_token };
  } catch {
    return { token: null, reauthReason: "Access expired — reconnect to continue" };
  }
}

export async function testMcpServer(
  db: DB,
  key: string,
  options: { userId: string; serverId: string },
  deps: McpDeps = defaultMcpDeps,
): Promise<{ server: McpServerRow; healthy: boolean }> {
  const server = await getOwnedMcpServer(db, options.userId, options.serverId);
  const now = new Date();

  const access = await getFreshAccessToken(db, key, server, deps);
  if (server.authType === "oauth" && access.token === null) {
    const rows = await db
      .update(mcpServer)
      .set({
        status: "needs_auth",
        lastError: access.reauthReason,
        lastTestedAt: now,
        updatedAt: now,
      })
      .where(eq(mcpServer.id, server.id))
      .returning();
    return { server: rows[0]!, healthy: false };
  }

  const probe = await deps.probe(server.url, access.token ?? undefined);
  const updates: Partial<typeof mcpServer.$inferInsert> = {
    lastTestedAt: now,
    updatedAt: now,
  };
  if (probe.ok) {
    updates.status = "connected";
    updates.serverInfo = JSON.stringify(probe.serverInfo);
    updates.lastConnectedAt = now;
    updates.lastError = null;
  } else if (probe.reason === "unauthorized") {
    updates.status = "needs_auth";
    updates.lastError = "Authentication required — reconnect this server";
  } else {
    updates.status = "error";
    updates.lastError = probe.message;
  }

  const rows = await db
    .update(mcpServer)
    .set(updates)
    .where(eq(mcpServer.id, server.id))
    .returning();
  return { server: rows[0]!, healthy: probe.ok };
}

async function revokeStoredTokens(key: string, server: McpServerRow, deps: McpDeps) {
  if (server.authType !== "oauth" || !server.oauthMetadata || !server.clientId) return;
  try {
    const { metadata, client } = await getStoredAuthState(key, server);
    // Revoking the refresh token invalidates the whole grant on conforming
    // servers; fall back to the access token when there is none.
    const token = server.refreshTokenEnc ?? server.accessTokenEnc;
    if (token) {
      await deps.revoke(metadata, { client, token: await decryptSecret(key, token) });
    }
  } catch {
    // Best effort — local credentials are removed regardless.
  }
}

export async function disconnectMcpServer(
  db: DB,
  key: string,
  options: { userId: string; serverId: string },
  deps: McpDeps = defaultMcpDeps,
) {
  const server = await getOwnedMcpServer(db, options.userId, options.serverId);
  await revokeStoredTokens(key, server, deps);
  const now = new Date();
  const rows = await db
    .update(mcpServer)
    .set({
      status: "disconnected",
      accessTokenEnc: null,
      refreshTokenEnc: null,
      accessTokenExpiresAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(mcpServer.id, server.id))
    .returning();
  return rows[0]!;
}

export async function deleteMcpServer(
  db: DB,
  key: string,
  options: { userId: string; serverId: string },
  deps: McpDeps = defaultMcpDeps,
) {
  const server = await getOwnedMcpServer(db, options.userId, options.serverId);
  await revokeStoredTokens(key, server, deps);
  await db.delete(mcpServer).where(eq(mcpServer.id, server.id));
}

// For consumers (e.g. chat sessions) that need to call the MCP server on the
// user's behalf. Returns null when the server needs (re-)authorization.
export async function getMcpAccessToken(
  db: DB,
  key: string,
  options: { userId: string; serverId: string },
  deps: McpDeps = defaultMcpDeps,
) {
  const server = await getOwnedMcpServer(db, options.userId, options.serverId);
  if (server.authType !== "oauth") return null;
  const access = await getFreshAccessToken(db, key, server, deps);
  return access.token;
}
