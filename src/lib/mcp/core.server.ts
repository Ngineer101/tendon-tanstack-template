import { and, eq, lt } from "drizzle-orm";

import { getDb, type DB } from "#/db";
import { mcpOauthSession, mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { hasEntitlement } from "#/lib/billing/core.server";
import type { McpServerPublic, McpServerStatus } from "./config";
import { FREE_MCP_SERVER_LIMIT } from "./config";
import { MCP_OAUTH_SESSION_TTL_MS, type McpEnv, type McpServerEnv } from "./config.server";
import {
  McpAuthRequiredError,
  performMcpHandshake,
  type McpHandshakeResult,
} from "./client.server";
import { decryptJson, encryptJson } from "./crypto.server";
import {
  buildAuthorizationUrl,
  discoverAuthorizationServer,
  exchangeAuthorizationCode,
  generatePkceMaterial,
  isTokenExpired,
  parseWwwAuthenticate,
  refreshAccessToken,
  registerClient,
  type McpAuthData,
  type OAuthServerMetadata,
} from "./oauth.server";
import { validateMcpServerUrl } from "./url";

type McpServerRow = typeof mcpServer.$inferSelect;

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Serializes a row for the browser. `encryptedAuthData` and any other
 * credential material must never be included here.
 */
export function toPublicServer(row: McpServerRow): McpServerPublic {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    status: row.status as McpServerStatus,
    authType: row.authType as McpServerPublic["authType"],
    authServerIssuer: row.authServerIssuer,
    serverName: row.serverName,
    serverVersion: row.serverVersion,
    toolCount: row.toolCount,
    lastTestedAt: row.lastTestedAt ? new Date(row.lastTestedAt).toISOString() : null,
    lastError: row.lastError,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

export async function listMcpServers(env: McpEnv, userId: string): Promise<McpServerPublic[]> {
  const db = getDb(env.DB);
  const rows = await db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  });
  return rows.map(toPublicServer);
}

async function getOwnedServer(db: DB, userId: string, serverId: string): Promise<McpServerRow> {
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  // 404 (not 403) so the existence of other users' servers is not revealed.
  if (!row) throw new ApiError(404, "MCP server not found");
  return row;
}

/**
 * Server-side enforcement of the per-plan connection limit. Free users are
 * limited to FREE_MCP_SERVER_LIMIT servers; the `unlimited_mcp_servers`
 * entitlement (granted by the pro subscription) lifts the cap.
 */
export async function assertCanAddServer(env: McpServerEnv, userId: string): Promise<void> {
  const db = getDb(env.DB);
  const existing = await db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    columns: { id: true },
  });
  if (existing.length < FREE_MCP_SERVER_LIMIT) return;

  const unlimited = await hasEntitlement(env, userId, "unlimited_mcp_servers");
  if (!unlimited) {
    throw new ApiError(
      403,
      `Free accounts can connect up to ${FREE_MCP_SERVER_LIMIT} MCP servers`,
      {
        code: "limit_reached",
        limit: FREE_MCP_SERVER_LIMIT,
      },
    );
  }
}

function normalizeName(raw: string | undefined, fallback: string): string {
  const name = (raw ?? "").trim() || fallback;
  if (name.length > 80) {
    throw new ApiError(400, "Server names are limited to 80 characters");
  }
  return name;
}

/** Sanitized, user-safe error strings. Raw upstream errors are never stored. */
const SAFE_ERRORS = {
  unauthorized: "Authorization required",
  authExpired: "Authorization expired, reconnect the server",
  unreachable: "Server unreachable",
  handshake: "MCP handshake failed",
} as const;

async function persistHandshake(db: DB, serverId: string, info: McpHandshakeResult): Promise<void> {
  await db
    .update(mcpServer)
    .set({
      status: "connected",
      serverName: info.serverName,
      serverVersion: info.serverVersion,
      toolCount: info.toolCount,
      lastTestedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(mcpServer.id, serverId));
}

interface PreparedOAuthFlow {
  authorizationUrl: string;
  authData: McpAuthData;
}

/**
 * Runs OAuth discovery + dynamic client registration for a server and stores
 * a single-use OAuth session (state + encrypted PKCE verifier). Reuses an
 * existing client registration when one is stored.
 */
async function prepareOAuthFlow(
  env: McpEnv,
  db: DB,
  userId: string,
  serverId: string,
  serverUrl: string,
  origin: string,
  options: { wwwAuthenticate?: string | null; existingAuth?: McpAuthData | null } = {},
): Promise<PreparedOAuthFlow> {
  const { resourceMetadata } = parseWwwAuthenticate(options.wwwAuthenticate ?? null);
  const metadata: OAuthServerMetadata = await discoverAuthorizationServer(serverUrl, {
    resourceMetadataUrl: resourceMetadata,
  });

  const registration =
    options.existingAuth && options.existingAuth.tokenEndpoint === metadata.tokenEndpoint
      ? { clientId: options.existingAuth.clientId, clientSecret: options.existingAuth.clientSecret }
      : await registerClient(metadata, `${origin}/api/mcp/oauth/callback`);

  const authData: McpAuthData = {
    kind: "oauth",
    issuer: metadata.issuer,
    authorizationEndpoint: metadata.authorizationEndpoint,
    tokenEndpoint: metadata.tokenEndpoint,
    clientId: registration.clientId,
    clientSecret: registration.clientSecret,
  };

  const pkce = await generatePkceMaterial();
  const encryptedVerifier = await encryptJson(env, { verifier: pkce.verifier });
  const now = new Date();
  await db.delete(mcpOauthSession).where(eq(mcpOauthSession.serverId, serverId));
  await db.insert(mcpOauthSession).values({
    id: createId("mcpos"),
    userId,
    serverId,
    state: pkce.state,
    encryptedVerifier,
    expiresAt: new Date(now.getTime() + MCP_OAUTH_SESSION_TTL_MS),
  });

  return {
    authorizationUrl: buildAuthorizationUrl(metadata, {
      clientId: registration.clientId,
      redirectUri: `${origin}/api/mcp/oauth/callback`,
      state: pkce.state,
      codeChallenge: pkce.challenge,
      resource: serverUrl,
    }),
    authData,
  };
}

export interface CreateServerResult {
  server: McpServerPublic;
  requiresAuth: boolean;
  authorizationUrl?: string;
}

export async function createMcpServer(
  env: McpServerEnv,
  userId: string,
  origin: string,
  input: { url: string; name?: string },
): Promise<CreateServerResult> {
  const validated = validateMcpServerUrl(input.url);
  const db = getDb(env.DB);

  await assertCanAddServer(env, userId);

  const duplicate = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.userId, userId), eq(mcpServer.url, validated.normalized)),
    columns: { id: true },
  });
  if (duplicate) {
    throw new ApiError(409, "This MCP server is already connected", { code: "duplicate" });
  }

  const name = normalizeName(input.name, validated.host);
  const id = createId("mcp");

  // Probe the server first: an unauthenticated handshake tells us whether
  // OAuth is required before anything is persisted.
  let handshake: McpHandshakeResult | null = null;
  let authRequired: McpAuthRequiredError | null = null;
  try {
    handshake = await performMcpHandshake(validated.normalized);
  } catch (error) {
    if (error instanceof McpAuthRequiredError) {
      authRequired = error;
    } else if (error instanceof ApiError) {
      throw error;
    } else {
      throw new ApiError(502, SAFE_ERRORS.unreachable);
    }
  }

  if (!authRequired && handshake) {
    await db.insert(mcpServer).values({
      id,
      userId,
      name,
      url: validated.normalized,
      status: "connected",
      authType: "none",
      serverName: handshake.serverName,
      serverVersion: handshake.serverVersion,
      toolCount: handshake.toolCount,
      lastTestedAt: new Date(),
    });
    const row = await getOwnedServer(db, userId, id);
    return { server: toPublicServer(row), requiresAuth: false };
  }

  // OAuth path: persist a pending connection first (the OAuth session row
  // references it), then discover, register and return the authorization URL
  // for the browser redirect.
  await db.insert(mcpServer).values({
    id,
    userId,
    name,
    url: validated.normalized,
    status: "pending_auth",
    authType: "oauth",
  });
  const flow = await prepareOAuthFlow(env, db, userId, id, validated.normalized, origin, {
    wwwAuthenticate: authRequired!.wwwAuthenticate,
  });
  await db
    .update(mcpServer)
    .set({
      authServerIssuer: flow.authData.issuer,
      encryptedAuthData: await encryptJson(env, flow.authData),
    })
    .where(eq(mcpServer.id, id));
  const row = await getOwnedServer(db, userId, id);
  return {
    server: toPublicServer(row),
    requiresAuth: true,
    authorizationUrl: flow.authorizationUrl,
  };
}

export interface UpdateServerResult {
  server: McpServerPublic;
  requiresAuth: boolean;
  authorizationUrl?: string;
}

export async function updateMcpServer(
  env: McpEnv,
  userId: string,
  origin: string,
  serverId: string,
  input: { name?: string; url?: string },
): Promise<UpdateServerResult> {
  const db = getDb(env.DB);
  const row = await getOwnedServer(db, userId, serverId);

  const urlChanged = input.url !== undefined && input.url !== row.url;
  if (input.name === undefined && !urlChanged) {
    throw new ApiError(400, "Nothing to update");
  }

  if (!urlChanged) {
    const name = normalizeName(input.name, row.name);
    await db.update(mcpServer).set({ name, updatedAt: new Date() }).where(eq(mcpServer.id, row.id));
    return {
      server: toPublicServer(await getOwnedServer(db, userId, serverId)),
      requiresAuth: false,
    };
  }

  // URL changes are treated like a fresh connection: re-validate, re-probe
  // and, when the new endpoint demands it, restart OAuth from scratch.
  const validated = validateMcpServerUrl(input.url!);
  const duplicate = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.userId, userId), eq(mcpServer.url, validated.normalized)),
    columns: { id: true },
  });
  if (duplicate && duplicate.id !== row.id) {
    throw new ApiError(409, "This MCP server is already connected", { code: "duplicate" });
  }

  let handshake: McpHandshakeResult | null = null;
  let authRequired: McpAuthRequiredError | null = null;
  try {
    handshake = await performMcpHandshake(validated.normalized);
  } catch (error) {
    if (error instanceof McpAuthRequiredError) {
      authRequired = error;
    } else if (error instanceof ApiError) {
      throw error;
    } else {
      throw new ApiError(502, SAFE_ERRORS.unreachable);
    }
  }

  if (!authRequired && handshake) {
    await db
      .update(mcpServer)
      .set({
        name: input.name !== undefined ? normalizeName(input.name, row.name) : row.name,
        url: validated.normalized,
        status: "connected",
        authType: "none",
        authServerIssuer: null,
        encryptedAuthData: null,
        serverName: handshake.serverName,
        serverVersion: handshake.serverVersion,
        toolCount: handshake.toolCount,
        lastTestedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(mcpServer.id, row.id));
    return {
      server: toPublicServer(await getOwnedServer(db, userId, serverId)),
      requiresAuth: false,
    };
  }

  const flow = await prepareOAuthFlow(env, db, userId, row.id, validated.normalized, origin, {
    wwwAuthenticate: authRequired!.wwwAuthenticate,
  });
  await db
    .update(mcpServer)
    .set({
      name: input.name !== undefined ? normalizeName(input.name, row.name) : row.name,
      url: validated.normalized,
      status: "pending_auth",
      authType: "oauth",
      authServerIssuer: flow.authData.issuer,
      encryptedAuthData: await encryptJson(env, flow.authData),
      serverName: null,
      serverVersion: null,
      toolCount: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(mcpServer.id, row.id));
  return {
    server: toPublicServer(await getOwnedServer(db, userId, serverId)),
    requiresAuth: true,
    authorizationUrl: flow.authorizationUrl,
  };
}

export async function deleteMcpServer(env: McpEnv, userId: string, serverId: string) {
  const db = getDb(env.DB);
  await getOwnedServer(db, userId, serverId);
  await db.delete(mcpServer).where(eq(mcpServer.id, serverId));
  return { deleted: true };
}

/**
 * Resolves a usable access token for a server, refreshing it when expired and
 * persisting rotated tokens. Returns null when the user must re-authorize.
 */
async function resolveAccessToken(
  env: McpEnv,
  db: DB,
  row: McpServerRow,
): Promise<{ accessToken?: string } | null> {
  if (row.authType !== "oauth") return {};
  if (!row.encryptedAuthData) return null;

  const auth = await decryptJson<McpAuthData>(env, row.encryptedAuthData);
  if (!auth.accessToken) return null;
  if (!isTokenExpired(auth)) return { accessToken: auth.accessToken };
  if (!auth.refreshToken) return null;

  try {
    const tokens = await refreshAccessToken(
      {
        issuer: auth.issuer,
        authorizationEndpoint: auth.authorizationEndpoint,
        tokenEndpoint: auth.tokenEndpoint,
        registrationEndpoint: null,
      },
      { clientId: auth.clientId, clientSecret: auth.clientSecret },
      { refreshToken: auth.refreshToken, resource: row.url },
    );
    const updated: McpAuthData = {
      ...auth,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope ?? auth.scope,
    };
    await db
      .update(mcpServer)
      .set({ encryptedAuthData: await encryptJson(env, updated), updatedAt: new Date() })
      .where(eq(mcpServer.id, row.id));
    return { accessToken: tokens.accessToken };
  } catch {
    return null;
  }
}

async function markAuthExpired(db: DB, serverId: string): Promise<void> {
  await db
    .update(mcpServer)
    .set({
      status: "auth_expired",
      lastTestedAt: new Date(),
      lastError: SAFE_ERRORS.authExpired,
      updatedAt: new Date(),
    })
    .where(eq(mcpServer.id, serverId));
}

export async function testMcpServer(
  env: McpEnv,
  userId: string,
  serverId: string,
): Promise<{ server: McpServerPublic }> {
  const db = getDb(env.DB);
  const row = await getOwnedServer(db, userId, serverId);

  const tokens = await resolveAccessToken(env, db, row);
  if (!tokens) {
    await markAuthExpired(db, row.id);
    throw new ApiError(401, "Reconnect this MCP server to continue", {
      code: "reconnect_required",
    });
  }

  try {
    const info = await performMcpHandshake(row.url, { accessToken: tokens.accessToken });
    await persistHandshake(db, row.id, info);
  } catch (error) {
    if (error instanceof McpAuthRequiredError) {
      await markAuthExpired(db, row.id);
      throw new ApiError(401, "Reconnect this MCP server to continue", {
        code: "reconnect_required",
      });
    }
    await db
      .update(mcpServer)
      .set({
        status: "error",
        lastTestedAt: new Date(),
        lastError:
          error instanceof ApiError && error.status === 502
            ? SAFE_ERRORS.unreachable
            : SAFE_ERRORS.handshake,
        updatedAt: new Date(),
      })
      .where(eq(mcpServer.id, row.id));
    throw new ApiError(502, "The MCP server failed the connection test");
  }

  return { server: toPublicServer(await getOwnedServer(db, userId, serverId)) };
}

export interface ReconnectResult {
  server: McpServerPublic;
  requiresAuth: boolean;
  authorizationUrl?: string;
}

export async function reconnectMcpServer(
  env: McpEnv,
  userId: string,
  origin: string,
  serverId: string,
): Promise<ReconnectResult> {
  const db = getDb(env.DB);
  const row = await getOwnedServer(db, userId, serverId);

  if (row.authType !== "oauth") {
    const { server } = await testMcpServer(env, userId, serverId);
    return { server, requiresAuth: false };
  }

  const existingAuth = row.encryptedAuthData
    ? await decryptJson<McpAuthData>(env, row.encryptedAuthData)
    : null;
  const flow = await prepareOAuthFlow(env, db, userId, row.id, row.url, origin, { existingAuth });
  await db
    .update(mcpServer)
    .set({
      status: "pending_auth",
      authServerIssuer: flow.authData.issuer,
      encryptedAuthData: await encryptJson(env, {
        ...flow.authData,
        // Keep existing tokens until the new grant completes so a cancelled
        // reconnect does not break a working connection.
        accessToken: existingAuth?.accessToken,
        refreshToken: existingAuth?.refreshToken,
        expiresAt: existingAuth?.expiresAt,
        scope: existingAuth?.scope,
      }),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(mcpServer.id, row.id));
  return {
    server: toPublicServer(await getOwnedServer(db, userId, serverId)),
    requiresAuth: true,
    authorizationUrl: flow.authorizationUrl,
  };
}

export type OauthCallbackOutcome =
  | { result: "connected"; serverId: string }
  | { result: "cancelled" }
  | {
      result: "error";
      reason: "invalid_state" | "expired" | "exchange_failed" | "handshake_failed";
    };

export async function handleOauthCallback(
  env: McpEnv,
  userId: string,
  origin: string,
  input: { state?: string; code?: string; error?: string },
): Promise<OauthCallbackOutcome> {
  const db = getDb(env.DB);

  if (!input.state) return { result: "error", reason: "invalid_state" };
  const oauthSession = await db.query.mcpOauthSession.findFirst({
    where: and(eq(mcpOauthSession.state, input.state), eq(mcpOauthSession.userId, userId)),
  });
  if (!oauthSession) return { result: "error", reason: "invalid_state" };

  // State is single-use: always consume it, whatever happens next.
  await db.delete(mcpOauthSession).where(eq(mcpOauthSession.id, oauthSession.id));

  if (input.error) {
    if (input.error === "access_denied") return { result: "cancelled" };
    return { result: "error", reason: "exchange_failed" };
  }
  if (oauthSession.expiresAt.getTime() < Date.now()) return { result: "error", reason: "expired" };
  if (!input.code) return { result: "error", reason: "invalid_state" };

  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, oauthSession.serverId), eq(mcpServer.userId, userId)),
  });
  if (!row?.encryptedAuthData) return { result: "error", reason: "invalid_state" };

  const auth = await decryptJson<McpAuthData>(env, row.encryptedAuthData);
  const { verifier } = await decryptJson<{ verifier: string }>(env, oauthSession.encryptedVerifier);

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode(
      {
        issuer: auth.issuer,
        authorizationEndpoint: auth.authorizationEndpoint,
        tokenEndpoint: auth.tokenEndpoint,
        registrationEndpoint: null,
      },
      { clientId: auth.clientId, clientSecret: auth.clientSecret },
      {
        code: input.code,
        redirectUri: `${origin}/api/mcp/oauth/callback`,
        codeVerifier: verifier,
        resource: row.url,
      },
    );
  } catch {
    return { result: "error", reason: "exchange_failed" };
  }

  const updatedAuth: McpAuthData = {
    ...auth,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
  };
  await db
    .update(mcpServer)
    .set({ encryptedAuthData: await encryptJson(env, updatedAuth), updatedAt: new Date() })
    .where(eq(mcpServer.id, row.id));

  try {
    const info = await performMcpHandshake(row.url, { accessToken: tokens.accessToken });
    await persistHandshake(db, row.id, info);
  } catch {
    await db
      .update(mcpServer)
      .set({
        status: "error",
        lastError: SAFE_ERRORS.handshake,
        lastTestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(mcpServer.id, row.id));
    return { result: "error", reason: "handshake_failed" };
  }

  return { result: "connected", serverId: row.id };
}

/**
 * Resolves decrypted, fresh auth material for chat-time MCP usage. Returns
 * null when the server needs re-authorization. Never expose the return value
 * to the browser.
 */
export async function getMcpAccessToken(
  env: McpEnv,
  userId: string,
  serverId: string,
): Promise<{ accessToken?: string } | null> {
  const db = getDb(env.DB);
  const row = await getOwnedServer(db, userId, serverId);
  return resolveAccessToken(env, db, row);
}

/** Best-effort cleanup of expired OAuth sessions; call from cron if desired. */
export async function pruneExpiredOauthSessions(env: McpEnv): Promise<void> {
  const db = getDb(env.DB);
  await db.delete(mcpOauthSession).where(lt(mcpOauthSession.expiresAt, new Date()));
}
