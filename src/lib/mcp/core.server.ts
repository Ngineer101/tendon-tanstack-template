import { and, asc, count, eq, lt, ne } from "drizzle-orm";

import { getDb, type DB } from "#/db";
import { mcpOauthSession, mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import {
  FREE_MCP_SERVER_LIMIT,
  MCP_ERROR_CODES,
  type McpServerListResponse,
  type McpServerView,
} from "./config";
import { decryptJson, encryptJson } from "./crypto.server";
import {
  buildAuthorizationUrl,
  discoverOAuthConfig,
  exchangeAuthorizationCode,
  generatePkcePair,
  probeMcpServer,
  refreshAccessToken,
  registerOAuthClient,
  type McpFetchOptions,
  type OAuthDiscovery,
  type ProbeResult,
  type TokenSet,
} from "./discovery.server";
import { assertSafePublicUrl, canonicalizeServerUrl } from "./url-guard.server";

export interface McpEnv extends Cloudflare.Env {
  MCP_TOKEN_ENCRYPTION_KEY: string;
  // Development-only escape hatch so localhost MCP servers can be connected.
  MCP_ALLOW_PRIVATE_NETWORK?: string;
}

export interface McpDeps {
  db: DB;
  encryptionKey: string;
  allowPrivateNetwork?: boolean;
  fetchFn?: typeof fetch;
}

const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;
// Refresh tokens slightly before expiry so a just-tested token doesn't die mid-use.
const TOKEN_EXPIRY_LEEWAY_MS = 30 * 1000;

export function getMcpDeps(env: McpEnv): McpDeps {
  if (!env.MCP_TOKEN_ENCRYPTION_KEY) {
    throw new ApiError(500, "MCP encryption key is not configured");
  }
  return {
    db: getDb(env.DB),
    encryptionKey: env.MCP_TOKEN_ENCRYPTION_KEY,
    allowPrivateNetwork: env.MCP_ALLOW_PRIVATE_NETWORK === "true",
  };
}

// Encrypted at rest; never serialized to the client.
interface StoredAuthData {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  scope?: string;
  expiresAt?: number;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  resource: string;
}

// Non-secret discovery results kept in plaintext for reconnects.
interface StoredOauthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string[];
  clientId?: string;
}

interface OauthSessionPayload {
  codeVerifier: string;
  redirectUri: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
  scopes?: string[];
}

type McpServerRow = typeof mcpServer.$inferSelect;

function fetchOptions(deps: McpDeps): McpFetchOptions {
  return { fetchFn: deps.fetchFn, allowPrivateNetwork: deps.allowPrivateNetwork };
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function serializeServer(row: McpServerRow): McpServerView {
  return {
    id: row.id,
    name: row.name,
    serverUrl: row.serverUrl,
    status: row.status as McpServerView["status"],
    authType: row.authType as McpServerView["authType"],
    serverName: row.serverName,
    serverVersion: row.serverVersion,
    toolCount: row.toolCount,
    lastError: row.lastError,
    lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function notFound(): ApiError {
  return new ApiError(404, "MCP server not found", { code: MCP_ERROR_CODES.not_found });
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 60) {
    throw new ApiError(400, "Name must be between 1 and 60 characters");
  }
  return name.trim();
}

async function getOwnedServer(deps: McpDeps, userId: string, serverId: string) {
  const row = await deps.db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  if (!row) throw notFound();
  return row;
}

async function countServers(deps: McpDeps, userId: string): Promise<number> {
  const [row] = await deps.db
    .select({ value: count() })
    .from(mcpServer)
    .where(eq(mcpServer.userId, userId));
  return row?.value ?? 0;
}

async function assertNoDuplicate(
  deps: McpDeps,
  userId: string,
  serverUrl: string,
  excludeServerId?: string,
) {
  const existing = await deps.db.query.mcpServer.findFirst({
    where: and(
      eq(mcpServer.userId, userId),
      eq(mcpServer.serverUrl, serverUrl),
      ...(excludeServerId ? [ne(mcpServer.id, excludeServerId)] : []),
    ),
  });
  if (existing) {
    throw new ApiError(409, "This MCP server is already connected", {
      code: MCP_ERROR_CODES.duplicate_server,
    });
  }
}

export async function listMcpServers(
  deps: McpDeps,
  userId: string,
  unlimited: boolean,
): Promise<McpServerListResponse> {
  const rows = await deps.db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    orderBy: [asc(mcpServer.createdAt), asc(mcpServer.id)],
  });
  return {
    servers: rows.map(serializeServer),
    limit: {
      max: unlimited ? null : FREE_MCP_SERVER_LIMIT,
      used: rows.length,
      canAdd: unlimited || rows.length < FREE_MCP_SERVER_LIMIT,
    },
  };
}

interface DiscoveredState {
  status: "connected" | "pending_auth";
  authType: "oauth" | "none";
  serverName?: string;
  serverVersion?: string;
  toolCount?: number;
  oauthMetadata?: StoredOauthMetadata;
}

// Probes the server and, when it demands authorization, runs OAuth discovery.
async function discoverServerState(deps: McpDeps, serverUrl: string): Promise<DiscoveredState> {
  const probe = await probeMcpServer(serverUrl, undefined, fetchOptions(deps));
  if (probe.status === "ok") {
    return {
      status: "connected",
      authType: "none",
      serverName: probe.serverName,
      serverVersion: probe.serverVersion,
      toolCount: probe.toolCount,
    };
  }

  const discovery = await discoverOAuthConfig(
    serverUrl,
    probe.resourceMetadataUrl,
    fetchOptions(deps),
  );
  return {
    status: "pending_auth",
    authType: "oauth",
    oauthMetadata: {
      issuer: discovery.issuer,
      authorizationEndpoint: discovery.authorizationEndpoint,
      tokenEndpoint: discovery.tokenEndpoint,
      registrationEndpoint: discovery.registrationEndpoint,
      scopes: discovery.scopes,
    },
  };
}

function limitError(): ApiError {
  return new ApiError(
    403,
    `Free accounts can connect up to ${FREE_MCP_SERVER_LIMIT} MCP servers. Upgrade to Pro for unlimited servers.`,
    { code: MCP_ERROR_CODES.server_limit_reached },
  );
}

export async function createMcpServer(
  deps: McpDeps,
  userId: string,
  input: { name: string; serverUrl: string },
  options: { unlimited: boolean },
): Promise<{ server: McpServerView; requiresAuth: boolean }> {
  const name = validateName(input.name);
  const url = assertSafePublicUrl(input.serverUrl, {
    allowPrivateNetwork: deps.allowPrivateNetwork,
  });
  const serverUrl = canonicalizeServerUrl(url);

  // Fast pre-checks before the (slow) network probe.
  if (!options.unlimited && (await countServers(deps, userId)) >= FREE_MCP_SERVER_LIMIT) {
    throw limitError();
  }
  await assertNoDuplicate(deps, userId, serverUrl);

  const state = await discoverServerState(deps, serverUrl);
  const now = new Date();
  const id = createId("mcp");

  await deps.db.insert(mcpServer).values({
    id,
    userId,
    name,
    serverUrl,
    status: state.status,
    authType: state.authType,
    oauthMetadata: state.oauthMetadata ? JSON.stringify(state.oauthMetadata) : null,
    serverName: state.serverName ?? null,
    serverVersion: state.serverVersion ?? null,
    toolCount: state.toolCount ?? null,
    lastConnectedAt: state.status === "connected" ? now : null,
    lastCheckedAt: now,
  });

  // Authoritative limit check after insert: concurrent creates could all pass the
  // pre-check, so whoever pushed the count over the limit removes its own row.
  if (!options.unlimited && (await countServers(deps, userId)) > FREE_MCP_SERVER_LIMIT) {
    await deps.db.delete(mcpServer).where(eq(mcpServer.id, id));
    throw limitError();
  }

  const row = await getOwnedServer(deps, userId, id);
  return { server: serializeServer(row), requiresAuth: state.status === "pending_auth" };
}

export async function updateMcpServer(
  deps: McpDeps,
  userId: string,
  serverId: string,
  patch: { name?: string; serverUrl?: string },
): Promise<{ server: McpServerView; requiresAuth: boolean }> {
  const row = await getOwnedServer(deps, userId, serverId);
  const updates: Partial<typeof mcpServer.$inferInsert> = { updatedAt: new Date() };
  let requiresAuth = false;

  if (patch.name !== undefined) {
    updates.name = validateName(patch.name);
  }

  if (patch.serverUrl !== undefined) {
    const url = assertSafePublicUrl(patch.serverUrl, {
      allowPrivateNetwork: deps.allowPrivateNetwork,
    });
    const serverUrl = canonicalizeServerUrl(url);
    if (serverUrl !== row.serverUrl) {
      await assertNoDuplicate(deps, userId, serverUrl, serverId);
      // A new URL is a new server: previous tokens must not be sent to it.
      const state = await discoverServerState(deps, serverUrl);
      const now = new Date();
      Object.assign(updates, {
        serverUrl,
        status: state.status,
        authType: state.authType,
        encryptedAuth: null,
        oauthMetadata: state.oauthMetadata ? JSON.stringify(state.oauthMetadata) : null,
        serverName: state.serverName ?? null,
        serverVersion: state.serverVersion ?? null,
        toolCount: state.toolCount ?? null,
        lastError: null,
        lastConnectedAt: state.status === "connected" ? now : null,
        lastCheckedAt: now,
      });
      requiresAuth = state.status === "pending_auth";
    }
  }

  await deps.db.update(mcpServer).set(updates).where(eq(mcpServer.id, serverId));
  const updated = await getOwnedServer(deps, userId, serverId);
  return { server: serializeServer(updated), requiresAuth };
}

export async function deleteMcpServer(deps: McpDeps, userId: string, serverId: string) {
  await getOwnedServer(deps, userId, serverId);
  await deps.db.delete(mcpOauthSession).where(eq(mcpOauthSession.serverId, serverId));
  await deps.db.delete(mcpServer).where(eq(mcpServer.id, serverId));
}

async function readStoredAuth(
  deps: McpDeps,
  row: McpServerRow,
): Promise<StoredAuthData | undefined> {
  if (!row.encryptedAuth) return undefined;
  return decryptJson<StoredAuthData>(deps.encryptionKey, row.encryptedAuth);
}

// Returns a valid access token for an owned, connected server, refreshing it if
// needed. Intended for server-side chat integrations; tokens never leave the server.
export async function getMcpAccessToken(
  deps: McpDeps,
  userId: string,
  serverId: string,
): Promise<{ serverUrl: string; accessToken?: string }> {
  const row = await getOwnedServer(deps, userId, serverId);
  const auth = await readStoredAuth(deps, row);
  if (!auth) return { serverUrl: row.serverUrl };
  const fresh = await ensureFreshToken(deps, row, auth);
  return { serverUrl: row.serverUrl, accessToken: fresh.accessToken };
}

async function ensureFreshToken(
  deps: McpDeps,
  row: McpServerRow,
  auth: StoredAuthData,
): Promise<StoredAuthData> {
  const isExpired =
    auth.expiresAt !== undefined && auth.expiresAt < Date.now() + TOKEN_EXPIRY_LEEWAY_MS;
  if (!isExpired) return auth;
  if (!auth.refreshToken) {
    throw new ApiError(401, "Authorization expired. Reconnect this server.", {
      code: MCP_ERROR_CODES.auth_expired,
    });
  }

  let tokens: TokenSet;
  try {
    tokens = await refreshAccessToken(
      {
        tokenEndpoint: auth.tokenEndpoint,
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        resource: auth.resource,
      },
      auth.refreshToken,
      fetchOptions(deps),
    );
  } catch {
    throw new ApiError(401, "Authorization expired. Reconnect this server.", {
      code: MCP_ERROR_CODES.auth_expired,
    });
  }

  const nextAuth: StoredAuthData = {
    ...auth,
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    refreshToken: tokens.refreshToken ?? auth.refreshToken,
    scope: tokens.scope ?? auth.scope,
    expiresAt: tokens.expiresAt,
  };
  await deps.db
    .update(mcpServer)
    .set({ encryptedAuth: await encryptJson(deps.encryptionKey, nextAuth), updatedAt: new Date() })
    .where(eq(mcpServer.id, row.id));
  return nextAuth;
}

export async function testMcpServer(
  deps: McpDeps,
  userId: string,
  serverId: string,
): Promise<{ server: McpServerView; ok: boolean; latencyMs?: number }> {
  const row = await getOwnedServer(deps, userId, serverId);
  const now = new Date();

  let accessToken: string | undefined;
  try {
    const auth = await readStoredAuth(deps, row);
    if (auth) {
      accessToken = (await ensureFreshToken(deps, row, auth)).accessToken;
    }
  } catch (error) {
    const message =
      error instanceof ApiError && error.details?.code === MCP_ERROR_CODES.auth_expired
        ? "Authorization expired. Reconnect this server."
        : "Stored authorization could not be read. Reconnect this server.";
    await deps.db
      .update(mcpServer)
      .set({ status: "pending_auth", lastError: message, lastCheckedAt: now, updatedAt: now })
      .where(eq(mcpServer.id, serverId));
    return { server: serializeServer(await getOwnedServer(deps, userId, serverId)), ok: false };
  }

  const startedAt = Date.now();
  let probe: ProbeResult | undefined;
  let failure: string | undefined;
  try {
    probe = await probeMcpServer(row.serverUrl, accessToken, fetchOptions(deps));
  } catch (error) {
    failure = error instanceof ApiError ? error.message : "Connection test failed";
  }
  const latencyMs = Date.now() - startedAt;

  if (probe?.status === "ok") {
    await deps.db
      .update(mcpServer)
      .set({
        status: "connected",
        serverName: probe.serverName ?? row.serverName,
        serverVersion: probe.serverVersion ?? row.serverVersion,
        toolCount: probe.toolCount ?? row.toolCount,
        lastError: null,
        lastConnectedAt: now,
        lastCheckedAt: now,
        updatedAt: now,
      })
      .where(eq(mcpServer.id, serverId));
    return {
      server: serializeServer(await getOwnedServer(deps, userId, serverId)),
      ok: true,
      latencyMs,
    };
  }

  const lastError =
    probe?.status === "auth_required"
      ? "The server requires authorization. Reconnect to continue."
      : (failure ?? "Connection test failed");
  await deps.db
    .update(mcpServer)
    .set({
      status: probe?.status === "auth_required" ? "pending_auth" : "error",
      lastError,
      lastCheckedAt: now,
      updatedAt: now,
    })
    .where(eq(mcpServer.id, serverId));
  return {
    server: serializeServer(await getOwnedServer(deps, userId, serverId)),
    ok: false,
    latencyMs,
  };
}

// Starts (or restarts) the OAuth flow for a server. Used for both the initial
// connect and reconnects after expiry or revocation.
export async function beginAuthorization(
  deps: McpDeps,
  userId: string,
  serverId: string,
  origin: string,
): Promise<{ authorizationUrl: string }> {
  const row = await getOwnedServer(deps, userId, serverId);

  let metadata: StoredOauthMetadata | undefined = row.oauthMetadata
    ? (JSON.parse(row.oauthMetadata) as StoredOauthMetadata)
    : undefined;

  if (!metadata) {
    // No stored discovery (URL was edited, or the server started requiring auth
    // after being connected without it): probe and discover from scratch.
    const probe = await probeMcpServer(row.serverUrl, undefined, fetchOptions(deps));
    if (probe.status === "ok") {
      throw new ApiError(400, "This server does not require authorization");
    }
    const discovery: OAuthDiscovery = await discoverOAuthConfig(
      row.serverUrl,
      probe.resourceMetadataUrl,
      fetchOptions(deps),
    );
    metadata = {
      issuer: discovery.issuer,
      authorizationEndpoint: discovery.authorizationEndpoint,
      tokenEndpoint: discovery.tokenEndpoint,
      registrationEndpoint: discovery.registrationEndpoint,
      scopes: discovery.scopes,
    };
  }

  const redirectUri = `${origin}/api/mcp/oauth/callback`;

  let clientId = metadata.clientId;
  let clientSecret: string | undefined;
  const previousAuth = await readStoredAuth(deps, row).catch(() => undefined);
  if (clientId && previousAuth?.clientId === clientId) {
    clientSecret = previousAuth.clientSecret;
  }
  if (!clientId) {
    if (!metadata.registrationEndpoint) {
      throw new ApiError(
        502,
        "This authorization server does not support automatic client registration",
        { code: MCP_ERROR_CODES.oauth_registration_failed },
      );
    }
    const registration = await registerOAuthClient(
      metadata.registrationEndpoint,
      redirectUri,
      fetchOptions(deps),
    );
    clientId = registration.clientId;
    clientSecret = registration.clientSecret;
    metadata = { ...metadata, clientId };
  }

  const pkce = await generatePkcePair();
  const state = createId("mcpstate");
  const payload: OauthSessionPayload = {
    codeVerifier: pkce.verifier,
    redirectUri,
    tokenEndpoint: metadata.tokenEndpoint,
    clientId,
    clientSecret,
    resource: row.serverUrl,
    scopes: metadata.scopes,
  };

  const now = new Date();
  await deps.db.delete(mcpOauthSession).where(lt(mcpOauthSession.expiresAt, now));
  await deps.db.insert(mcpOauthSession).values({
    id: state,
    serverId,
    userId,
    encryptedPayload: await encryptJson(deps.encryptionKey, payload),
    expiresAt: new Date(now.getTime() + OAUTH_SESSION_TTL_MS),
  });
  await deps.db
    .update(mcpServer)
    .set({ oauthMetadata: JSON.stringify(metadata), updatedAt: now })
    .where(eq(mcpServer.id, serverId));

  return {
    authorizationUrl: buildAuthorizationUrl({
      authorizationEndpoint: metadata.authorizationEndpoint,
      clientId,
      redirectUri,
      state,
      codeChallenge: pkce.challenge,
      resource: row.serverUrl,
      scopes: metadata.scopes,
    }),
  };
}

function stateError(): ApiError {
  return new ApiError(400, "Authorization session is invalid or has expired", {
    code: MCP_ERROR_CODES.oauth_state_invalid,
  });
}

export async function completeAuthorization(
  deps: McpDeps,
  userId: string,
  input: { state: string; code: string },
): Promise<{ serverId: string }> {
  const session = await deps.db.query.mcpOauthSession.findFirst({
    where: eq(mcpOauthSession.id, input.state),
  });
  if (!session || session.userId !== userId) throw stateError();

  // Single use: remove before the exchange so a replayed callback cannot reuse it.
  await deps.db.delete(mcpOauthSession).where(eq(mcpOauthSession.id, session.id));
  if (session.expiresAt.getTime() < Date.now()) throw stateError();

  const payload = await decryptJson<OauthSessionPayload>(
    deps.encryptionKey,
    session.encryptedPayload,
  );
  const row = await getOwnedServer(deps, userId, session.serverId);

  const tokens = await exchangeAuthorizationCode(
    {
      tokenEndpoint: payload.tokenEndpoint,
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      resource: payload.resource,
    },
    { code: input.code, redirectUri: payload.redirectUri, codeVerifier: payload.codeVerifier },
    fetchOptions(deps),
  );

  const storedAuth: StoredAuthData = {
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    refreshToken: tokens.refreshToken,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
    clientId: payload.clientId,
    clientSecret: payload.clientSecret,
    tokenEndpoint: payload.tokenEndpoint,
    resource: payload.resource,
  };

  // Confirm the token actually works before declaring the server connected.
  let probe: ProbeResult | undefined;
  try {
    probe = await probeMcpServer(row.serverUrl, tokens.accessToken, fetchOptions(deps));
  } catch {
    probe = undefined;
  }
  const okProbe = probe?.status === "ok" ? probe : undefined;
  const now = new Date();
  await deps.db
    .update(mcpServer)
    .set({
      authType: "oauth",
      encryptedAuth: await encryptJson(deps.encryptionKey, storedAuth),
      status: okProbe ? "connected" : "error",
      serverName: okProbe?.serverName ?? row.serverName,
      serverVersion: okProbe?.serverVersion ?? row.serverVersion,
      toolCount: okProbe?.toolCount ?? row.toolCount,
      lastError: okProbe ? null : "Authorized, but the connection check failed. Try testing it.",
      lastConnectedAt: okProbe ? now : row.lastConnectedAt,
      lastCheckedAt: now,
      updatedAt: now,
    })
    .where(eq(mcpServer.id, row.id));

  return { serverId: row.id };
}
