import { and, count, desc, eq, gte, lt, ne } from "drizzle-orm";

import { getDb } from "#/db";
import { mcpOAuthState, mcpServerConnection } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { hasEntitlement } from "#/lib/billing/core.server";
import type { BillingEnv } from "#/lib/billing/config.server";

export const FREE_MCP_SERVER_LIMIT = 3;

const SAFE_FETCH_HEADERS = {
  accept: "application/json, application/oauth-authz-server+jwt;q=0.8",
};

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_DISCOVERY_BYTES = 64_000;
const MAX_TOKEN_BYTES = 64_000;
const OUTBOUND_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_SKEW_SECONDS = 60;
const MCP_PROTOCOL_VERSION = "2025-11-25";

export const MCP_INSERT_CONNECTION_SQL = `
INSERT INTO mcp_server_connection (
  id, user_id, name, server_url, status, auth_data_encrypted,
  oauth_issuer, oauth_client_id, scopes, last_error, created_at, updated_at
)
SELECT ?, ?, ?, ?, 'connected', ?, ?, ?, ?, NULL, unixepoch(), unixepoch()
WHERE ? = 1
   OR EXISTS (
     SELECT 1 FROM mcp_server_connection
     WHERE user_id = ? AND server_url = ? AND status <> 'disconnected'
   )
   OR (
     SELECT COUNT(*) FROM mcp_server_connection
     WHERE user_id = ? AND status <> 'disconnected'
   ) < ?
ON CONFLICT(user_id, server_url) DO UPDATE SET
  name = excluded.name,
  status = 'connected',
  auth_data_encrypted = excluded.auth_data_encrypted,
  oauth_issuer = excluded.oauth_issuer,
  oauth_client_id = excluded.oauth_client_id,
  scopes = excluded.scopes,
  last_error = NULL,
  updated_at = unixepoch()
`;

export const MCP_RECONNECT_CONNECTION_SQL = `
UPDATE mcp_server_connection
SET name = ?, server_url = ?, status = 'connected', auth_data_encrypted = ?,
    oauth_issuer = ?, oauth_client_id = ?, scopes = ?, last_error = NULL,
    updated_at = unixepoch()
WHERE id = ? AND user_id = ?
  AND (
    ? = 1
    OR status <> 'disconnected'
    OR (
      SELECT COUNT(*) FROM mcp_server_connection
      WHERE user_id = ? AND status <> 'disconnected'
    ) < ?
  )
`;

export type McpConnectionStatus = "connected" | "needs_reconnect" | "error" | "disconnected";

export interface McpEnv extends BillingEnv {
  MCP_AUTH_ENCRYPTION_KEY: string;
  MCP_OAUTH_CLIENT_ID?: string;
  MCP_OAUTH_CLIENT_SECRET?: string;
}

export interface McpConnectionView {
  id: string;
  name: string;
  serverUrl: string;
  status: McpConnectionStatus;
  oauthIssuer: string | null;
  scopes: string | null;
  lastTestedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface McpChatConnection {
  id: string;
  name: string;
  serverUrl: string;
  authorization: string;
}

interface OAuthServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  authorization_servers?: string[];
  resource?: string;
  scope?: string;
}

interface OAuthClientRegistration {
  client_id: string;
  client_secret?: string;
}

interface DiscoveredOAuthServer {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported: string[];
  resource: string;
}

interface BeginMcpOAuthInput {
  userId: string;
  serverUrl: string;
  name?: string;
  scope?: string;
  origin: string;
  connectionId?: string;
}

interface StoredAuthData {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number;
  scope?: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
}

type Fetcher = typeof fetch;

export function isUnlimitedMcpPlan(plan: "free" | "pro_monthly") {
  return plan === "pro_monthly";
}

export function assertCanConnectMcpServer(options: {
  plan: "free" | "pro_monthly";
  activeServerCount: number;
  existingStatus?: McpConnectionStatus;
}) {
  if (
    isUnlimitedMcpPlan(options.plan) ||
    (options.existingStatus && options.existingStatus !== "disconnected")
  ) {
    return;
  }

  if (options.activeServerCount >= FREE_MCP_SERVER_LIMIT) {
    throw new ApiError(402, "Free accounts can connect up to 3 MCP servers.", {
      limit: FREE_MCP_SERVER_LIMIT,
    });
  }
}

export function assertMcpConnectionOwner<TConnection extends { userId: string }>(
  connection: TConnection | undefined,
  userId: string,
): asserts connection is TConnection {
  if (!connection || connection.userId !== userId) {
    throw new ApiError(404, "MCP server connection not found");
  }
}

export function normalizeMcpServerUrl(input: string) {
  if (typeof input !== "string" || input.length > 2_048) {
    throw new ApiError(400, "Enter a valid HTTPS server URL.");
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ApiError(400, "Enter a valid HTTPS server URL.");
  }

  assertSafeOutboundUrl(url);
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString();
}

export function assertSafeOutboundUrl(input: string | URL) {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    throw new ApiError(400, "OAuth discovery returned an invalid endpoint URL.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (url.protocol !== "https:") {
    throw new ApiError(400, "MCP server URLs must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "Credentials are not allowed in MCP server URLs.");
  }
  if (!hostname.includes(".") && !hostname.includes(":")) {
    throw new ApiError(400, "Use a public fully qualified hostname for MCP servers.");
  }
  if (hostname.includes(":") || isUnsafeHostname(hostname) || isPrivateIpLiteral(hostname)) {
    throw new ApiError(400, "This MCP server URL points to a restricted network address.");
  }

  return url;
}

export async function listMcpServers(env: McpEnv, userId: string) {
  const db = getDb(env.DB);
  const [unlimited, servers, activeCount] = await Promise.all([
    hasEntitlement(env, userId, "unlimited_mcp_servers"),
    db.query.mcpServerConnection.findMany({
      where: eq(mcpServerConnection.userId, userId),
      orderBy: [desc(mcpServerConnection.createdAt)],
    }),
    getActiveMcpServerCount(env, userId),
  ]);

  const plan = unlimited ? "pro_monthly" : "free";
  const limit = unlimited ? null : FREE_MCP_SERVER_LIMIT;
  return {
    plan,
    limit,
    activeCount,
    remaining: limit === null ? null : Math.max(0, limit - activeCount),
    servers: servers.map(toConnectionView),
  };
}

export async function discoverMcpOAuth(
  serverUrl: string,
  fetcher: Fetcher = fetch,
): Promise<DiscoveredOAuthServer> {
  const normalizedServerUrl = normalizeMcpServerUrl(serverUrl);
  const server = new URL(normalizedServerUrl);
  const protectedResourceUrls = new Set<string>();

  const challenge = await getResourceMetadataFromChallenge(normalizedServerUrl, fetcher);
  if (challenge?.metadataUrl) protectedResourceUrls.add(challenge.metadataUrl);

  const endpointPath = server.pathname === "/" ? "" : server.pathname;
  protectedResourceUrls.add(
    new URL(`/.well-known/oauth-protected-resource${endpointPath}`, server.origin).toString(),
  );
  protectedResourceUrls.add(
    new URL("/.well-known/oauth-protected-resource", server.origin).toString(),
  );

  const authorizationServerUrls = new Set<string>();
  const discoveredScopes = new Set<string>(parseScope(challenge?.scope));
  let resource = normalizedServerUrl;

  for (const metadataUrl of protectedResourceUrls) {
    const metadata = await tryFetchOAuthMetadata(metadataUrl, fetcher);
    if (!metadata) continue;

    for (const scope of validateDiscoveredScopes(metadata.scopes_supported)) {
      discoveredScopes.add(scope);
    }
    if (metadata.resource) {
      const advertisedResource = assertSafeOutboundUrl(metadata.resource);
      if (advertisedResource.origin !== server.origin) {
        throw new ApiError(422, "MCP resource metadata does not match the configured server.");
      }
      resource = advertisedResource.toString();
    }

    if (metadata.authorization_endpoint && metadata.token_endpoint) {
      return toDiscoveredOAuthServer(metadata, resource, [...discoveredScopes]);
    }

    for (const authorizationServer of metadata.authorization_servers ?? []) {
      authorizationServerUrls.add(authorizationServer);
    }
  }

  // Compatibility fallback for older MCP servers that publish authorization metadata at origin.
  if (!authorizationServerUrls.size) authorizationServerUrls.add(server.origin);

  for (const authorizationServer of authorizationServerUrls) {
    const issuer = assertSafeOutboundUrl(authorizationServer);
    const issuerPaths = buildAuthorizationMetadataUrls(issuer);

    for (const metadataUrl of issuerPaths) {
      const metadata = await tryFetchOAuthMetadata(metadataUrl, fetcher);
      if (metadata?.authorization_endpoint && metadata.token_endpoint) {
        return toDiscoveredOAuthServer(metadata, resource, [...discoveredScopes], issuer);
      }
    }
  }

  throw new ApiError(422, "OAuth discovery did not find authorization and token endpoints.");
}

export async function beginMcpOAuth(env: McpEnv, input: BeginMcpOAuthInput) {
  const normalizedServerUrl = normalizeMcpServerUrl(input.serverUrl);
  const db = getDb(env.DB);
  let existingStatus: McpConnectionStatus | undefined;

  await db
    .delete(mcpOAuthState)
    .where(and(eq(mcpOAuthState.userId, input.userId), lt(mcpOAuthState.expiresAt, new Date())));

  if (input.connectionId) {
    const existing = await db.query.mcpServerConnection.findFirst({
      where: eq(mcpServerConnection.id, input.connectionId),
    });
    assertMcpConnectionOwner(existing, input.userId);
    existingStatus = existing.status as McpConnectionStatus;

    if (existing.serverUrl !== normalizedServerUrl) {
      const duplicate = await db.query.mcpServerConnection.findFirst({
        where: and(
          eq(mcpServerConnection.userId, input.userId),
          eq(mcpServerConnection.serverUrl, normalizedServerUrl),
          ne(mcpServerConnection.id, input.connectionId),
        ),
      });
      if (duplicate) {
        throw new ApiError(409, "You already have an MCP connection for this server URL.");
      }
    }
  }

  const [unlimited, activeServerCount] = await Promise.all([
    hasEntitlement(env, input.userId, "unlimited_mcp_servers"),
    getActiveMcpServerCount(env, input.userId),
  ]);
  assertCanConnectMcpServer({
    plan: unlimited ? "pro_monthly" : "free",
    activeServerCount,
    existingStatus,
  });

  const discovery = await discoverMcpOAuth(normalizedServerUrl);
  const redirectUri = new URL(
    "/api/mcp/oauth/callback",
    getTrustedOrigin(env, input.origin),
  ).toString();
  const client = await resolveOAuthClient(env, discovery, redirectUri);
  const state = randomUrlToken(32);
  const codeVerifier = randomUrlToken(64);
  const codeChallenge = await pkceChallenge(codeVerifier);
  const scope = sanitizeScope(input.scope, discovery.scopesSupported);
  const authorizationUrl = new URL(discovery.authorizationEndpoint);

  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", client.client_id);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("resource", discovery.resource);
  if (scope) authorizationUrl.searchParams.set("scope", scope);

  const transientSecrets = await encryptJson(env.MCP_AUTH_ENCRYPTION_KEY, {
    codeVerifier,
    clientSecret: client.client_secret,
  });
  const stateHash = await hashOAuthState(state);

  await db.insert(mcpOAuthState).values({
    state: stateHash,
    userId: input.userId,
    connectionId: input.connectionId,
    name: normalizeConnectionName(input.name, normalizedServerUrl),
    serverUrl: normalizedServerUrl,
    resource: discovery.resource,
    authorizationEndpoint: discovery.authorizationEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
    issuer: discovery.issuer,
    clientId: client.client_id,
    clientSecretEncrypted: transientSecrets,
    codeVerifier: "encrypted:v1",
    scope,
    redirectUri,
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });

  return {
    authorizationUrl: authorizationUrl.toString(),
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  };
}

export async function completeMcpOAuth(
  env: McpEnv,
  options: { userId: string; state: string; code: string },
) {
  const db = getDb(env.DB);
  const stateHash = await hashOAuthState(options.state);
  const [oauthState] = await db
    .delete(mcpOAuthState)
    .where(
      and(
        eq(mcpOAuthState.state, stateHash),
        eq(mcpOAuthState.userId, options.userId),
        gte(mcpOAuthState.expiresAt, new Date()),
      ),
    )
    .returning();

  if (!oauthState) {
    throw new ApiError(400, "OAuth session expired. Start the MCP connection again.");
  }

  const transientSecrets = await decryptJson<{
    codeVerifier: string;
    clientSecret?: string;
  }>(env.MCP_AUTH_ENCRYPTION_KEY, oauthState.clientSecretEncrypted ?? "");
  const clientSecret = transientSecrets.clientSecret ?? env.MCP_OAUTH_CLIENT_SECRET;

  const tokenResponse = await exchangeOAuthCode({
    tokenEndpoint: oauthState.tokenEndpoint,
    code: options.code,
    clientId: oauthState.clientId,
    clientSecret,
    codeVerifier: transientSecrets.codeVerifier,
    redirectUri: oauthState.redirectUri,
    resource: oauthState.resource,
  });

  const authData: StoredAuthData = {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    tokenType: tokenResponse.token_type,
    expiresAt:
      typeof tokenResponse.expires_in === "number"
        ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
        : undefined,
    scope: tokenResponse.scope ?? oauthState.scope ?? undefined,
    tokenEndpoint: oauthState.tokenEndpoint,
    clientId: oauthState.clientId,
    clientSecret,
    resource: oauthState.resource,
  };
  const encryptedAuthData = await encryptJson(env.MCP_AUTH_ENCRYPTION_KEY, authData);
  const unlimited = await hasEntitlement(env, options.userId, "unlimited_mcp_servers");
  await persistCompletedMcpConnection(env, {
    connectionId: oauthState.connectionId ?? undefined,
    encryptedAuthData,
    issuer: oauthState.issuer,
    name: oauthState.name,
    oauthClientId: oauthState.clientId,
    scopes: authData.scope ?? oauthState.scope,
    serverUrl: oauthState.serverUrl,
    unlimited,
    userId: options.userId,
  });
}

export async function updateMcpServer(
  env: McpEnv,
  userId: string,
  serverId: string,
  input: { name?: string; serverUrl?: string },
) {
  const db = getDb(env.DB);
  const existing = await db.query.mcpServerConnection.findFirst({
    where: eq(mcpServerConnection.id, serverId),
  });
  assertMcpConnectionOwner(existing, userId);

  const nextServerUrl = input.serverUrl
    ? normalizeMcpServerUrl(input.serverUrl)
    : existing.serverUrl;
  const serverUrlChanged = nextServerUrl !== existing.serverUrl;

  if (serverUrlChanged) {
    const duplicate = await db.query.mcpServerConnection.findFirst({
      where: and(
        eq(mcpServerConnection.userId, userId),
        eq(mcpServerConnection.serverUrl, nextServerUrl),
        ne(mcpServerConnection.id, serverId),
      ),
    });
    if (duplicate) {
      throw new ApiError(409, "You already have an MCP connection for this server URL.");
    }
  }

  await db
    .update(mcpServerConnection)
    .set({
      name: normalizeConnectionName(input.name ?? existing.name, nextServerUrl),
      serverUrl: nextServerUrl,
      status: serverUrlChanged ? "needs_reconnect" : existing.status,
      authDataEncrypted: serverUrlChanged ? null : existing.authDataEncrypted,
      oauthIssuer: serverUrlChanged ? null : existing.oauthIssuer,
      oauthClientId: serverUrlChanged ? null : existing.oauthClientId,
      scopes: serverUrlChanged ? null : existing.scopes,
      lastTestedAt: serverUrlChanged ? null : existing.lastTestedAt,
      lastError: serverUrlChanged
        ? "Reconnect to authorize the updated server URL."
        : existing.lastError,
      updatedAt: new Date(),
    })
    .where(eq(mcpServerConnection.id, serverId));
}

export async function disconnectMcpServer(env: McpEnv, userId: string, serverId: string) {
  const db = getDb(env.DB);
  const existing = await db.query.mcpServerConnection.findFirst({
    where: eq(mcpServerConnection.id, serverId),
  });
  assertMcpConnectionOwner(existing, userId);

  await db
    .update(mcpServerConnection)
    .set({
      status: "disconnected",
      authDataEncrypted: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(mcpServerConnection.id, serverId));
}

export async function testMcpServer(env: McpEnv, userId: string, serverId: string) {
  const db = getDb(env.DB);
  const existing = await db.query.mcpServerConnection.findFirst({
    where: eq(mcpServerConnection.id, serverId),
  });
  assertMcpConnectionOwner(existing, userId);

  if (!existing.authDataEncrypted || existing.status === "disconnected") {
    throw new ApiError(409, "Reconnect this MCP server before testing it.");
  }

  const authData = await getFreshAuthData(env, {
    ...existing,
    authDataEncrypted: existing.authDataEncrypted,
  });
  const serverUrl = normalizeMcpServerUrl(existing.serverUrl);
  const response = await safeFetch(serverUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${authData.accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      origin: getTrustedOrigin(env, env.BETTER_AUTH_URL),
    },
    redirect: "manual",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `connection-test-${crypto.randomUUID()}`,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Tendon MCP Connector", version: "1.0" },
      },
    }),
  });

  const ok = response.status >= 200 && response.status < 300;
  const needsReconnect = response.status === 401;
  const lastError = ok
    ? null
    : needsReconnect
      ? "Authorization expired. Reconnect this server."
      : response.status === 403
        ? "The authorized account does not have the required MCP scopes."
        : `MCP initialize returned HTTP ${response.status}.`;
  await response.body?.cancel();

  await db
    .update(mcpServerConnection)
    .set({
      status: ok ? "connected" : needsReconnect ? "needs_reconnect" : "error",
      lastTestedAt: new Date(),
      lastError,
      updatedAt: new Date(),
    })
    .where(eq(mcpServerConnection.id, serverId));

  if (!ok) {
    throw new ApiError(502, lastError ?? "Unable to reach MCP server");
  }

  return { ok: true };
}

/**
 * Server-only adapter for chat handlers. Never serialize this return value to a client or log it.
 */
export async function getMcpConnectionsForChat(
  env: McpEnv,
  userId: string,
): Promise<McpChatConnection[]> {
  const db = getDb(env.DB);
  const connections = await db.query.mcpServerConnection.findMany({
    where: and(eq(mcpServerConnection.userId, userId), eq(mcpServerConnection.status, "connected")),
  });

  const resolved = await Promise.all(
    connections
      .filter(
        (connection): connection is typeof connection & { authDataEncrypted: string } =>
          !!connection.authDataEncrypted,
      )
      .map(async (connection) => {
        try {
          const authData = await getFreshAuthData(env, connection);
          return {
            id: connection.id,
            name: connection.name,
            serverUrl: normalizeMcpServerUrl(connection.serverUrl),
            authorization: `Bearer ${authData.accessToken}`,
          };
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) return null;
          throw error;
        }
      }),
  );
  return resolved.filter((connection): connection is McpChatConnection => connection !== null);
}

async function persistCompletedMcpConnection(
  env: McpEnv,
  input: {
    connectionId?: string;
    encryptedAuthData: string;
    issuer: string | null;
    name: string;
    oauthClientId: string;
    scopes: string | null;
    serverUrl: string;
    unlimited: boolean;
    userId: string;
  },
) {
  const values = [
    input.name,
    input.serverUrl,
    input.encryptedAuthData,
    input.issuer,
    input.oauthClientId,
    input.scopes,
  ];
  const statement = input.connectionId
    ? env.DB.prepare(MCP_RECONNECT_CONNECTION_SQL).bind(
        ...values,
        input.connectionId,
        input.userId,
        input.unlimited ? 1 : 0,
        input.userId,
        FREE_MCP_SERVER_LIMIT,
      )
    : env.DB.prepare(MCP_INSERT_CONNECTION_SQL).bind(
        createId("mcp"),
        input.userId,
        ...values,
        input.unlimited ? 1 : 0,
        input.userId,
        input.serverUrl,
        input.userId,
        FREE_MCP_SERVER_LIMIT,
      );
  const result = await statement.run();

  if (result.meta.changes === 0) {
    throw new ApiError(402, "Free accounts can connect up to 3 MCP servers.", {
      limit: FREE_MCP_SERVER_LIMIT,
    });
  }
}

async function getFreshAuthData(
  env: McpEnv,
  connection: typeof mcpServerConnection.$inferSelect & { authDataEncrypted: string },
) {
  const authData = await decryptJson<StoredAuthData>(
    env.MCP_AUTH_ENCRYPTION_KEY,
    connection.authDataEncrypted,
  );
  const now = Math.floor(Date.now() / 1_000);
  if (!authData.expiresAt || authData.expiresAt > now + TOKEN_REFRESH_SKEW_SECONDS) {
    return authData;
  }
  if (!authData.refreshToken) {
    await getDb(env.DB)
      .update(mcpServerConnection)
      .set({
        status: "needs_reconnect",
        lastError: "Authorization expired. Reconnect this server.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mcpServerConnection.id, connection.id),
          eq(mcpServerConnection.userId, connection.userId),
        ),
      );
    throw new ApiError(409, "MCP authorization expired. Reconnect this server.");
  }

  let refreshed: Awaited<ReturnType<typeof refreshOAuthToken>>;
  try {
    refreshed = await refreshOAuthToken(authData);
  } catch {
    await getDb(env.DB)
      .update(mcpServerConnection)
      .set({
        status: "needs_reconnect",
        lastError: "Authorization expired. Reconnect this server.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mcpServerConnection.id, connection.id),
          eq(mcpServerConnection.userId, connection.userId),
        ),
      );
    throw new ApiError(409, "MCP authorization expired. Reconnect this server.");
  }

  const updated: StoredAuthData = {
    ...authData,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? authData.refreshToken,
    tokenType: refreshed.token_type ?? authData.tokenType,
    scope: refreshed.scope ?? authData.scope,
    expiresAt: typeof refreshed.expires_in === "number" ? now + refreshed.expires_in : undefined,
  };
  const encrypted = await encryptJson(env.MCP_AUTH_ENCRYPTION_KEY, updated);
  await getDb(env.DB)
    .update(mcpServerConnection)
    .set({
      authDataEncrypted: encrypted,
      status: "connected",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mcpServerConnection.id, connection.id),
        eq(mcpServerConnection.userId, connection.userId),
      ),
    );
  return updated;
}

async function getActiveMcpServerCount(env: McpEnv, userId: string) {
  const db = getDb(env.DB);
  const [result] = await db
    .select({ value: count() })
    .from(mcpServerConnection)
    .where(
      and(eq(mcpServerConnection.userId, userId), ne(mcpServerConnection.status, "disconnected")),
    );
  return result?.value ?? 0;
}

function toConnectionView(connection: typeof mcpServerConnection.$inferSelect): McpConnectionView {
  return {
    id: connection.id,
    name: connection.name,
    serverUrl: connection.serverUrl,
    status: connection.status as McpConnectionStatus,
    oauthIssuer: connection.oauthIssuer,
    scopes: connection.scopes,
    lastTestedAt: connection.lastTestedAt,
    lastError: connection.lastError,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

async function resolveOAuthClient(
  env: McpEnv,
  discovery: DiscoveredOAuthServer,
  redirectUri: string,
): Promise<OAuthClientRegistration> {
  if (env.MCP_OAUTH_CLIENT_ID) {
    return {
      client_id: env.MCP_OAUTH_CLIENT_ID,
      client_secret: env.MCP_OAUTH_CLIENT_SECRET,
    };
  }

  if (!discovery.registrationEndpoint) {
    throw new ApiError(
      422,
      "This MCP server does not advertise dynamic client registration. Configure MCP_OAUTH_CLIENT_ID on the server to connect it.",
    );
  }

  const response = await safeFetch(discovery.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    redirect: "manual",
    body: JSON.stringify({
      client_name: "Tendon MCP Connector",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!response.ok) {
    throw new ApiError(502, "MCP OAuth client registration failed.");
  }

  const registration = await readBoundedJson<Partial<OAuthClientRegistration>>(
    response,
    MAX_TOKEN_BYTES,
    "MCP OAuth registration response is too large.",
  );
  if (
    typeof registration.client_id !== "string" ||
    !registration.client_id ||
    registration.client_id.length > 2_048
  ) {
    throw new ApiError(502, "MCP OAuth registration response did not include a client ID.");
  }
  return registration as OAuthClientRegistration;
}

async function exchangeOAuthCode(options: {
  tokenEndpoint: string;
  code: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    client_id: options.clientId,
    code_verifier: options.codeVerifier,
    redirect_uri: options.redirectUri,
    resource: options.resource,
  });
  if (options.clientSecret) body.set("client_secret", options.clientSecret);

  const response = await safeFetch(options.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    redirect: "manual",
  });

  if (!response.ok) {
    throw new ApiError(502, "MCP OAuth token exchange failed.");
  }

  const payload = await readBoundedJson<{
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
  }>(response, MAX_TOKEN_BYTES, "MCP OAuth token response is too large.");
  if (!isSafeToken(payload.access_token)) {
    throw new ApiError(502, "MCP OAuth token response did not include an access token.");
  }
  return { ...payload, access_token: payload.access_token };
}

async function refreshOAuthToken(authData: StoredAuthData) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: authData.refreshToken ?? "",
    client_id: authData.clientId,
    resource: authData.resource,
  });
  if (authData.clientSecret) body.set("client_secret", authData.clientSecret);

  const response = await safeFetch(authData.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!response.ok) throw new ApiError(502, "MCP OAuth token refresh failed.");

  const payload = await readBoundedJson<{
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
  }>(response, MAX_TOKEN_BYTES, "MCP OAuth token response is too large.");
  if (!isSafeToken(payload.access_token)) {
    throw new ApiError(502, "MCP OAuth refresh response did not include an access token.");
  }
  return { ...payload, access_token: payload.access_token };
}

async function getResourceMetadataFromChallenge(serverUrl: string, fetcher: Fetcher) {
  let response: Response;
  try {
    response = await safeFetch(
      serverUrl,
      {
        method: "GET",
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
      },
      fetcher,
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return undefined;
  }

  if (isRedirect(response.status)) {
    throw new ApiError(400, "MCP discovery redirects are not followed.");
  }

  const header = response.headers.get("www-authenticate");
  await response.body?.cancel();
  if (!header) return undefined;

  const metadataMatch = header.match(/resource_metadata="([^"]+)"/i);
  const scopeMatch = header.match(/scope="([^"]+)"/i);
  return {
    metadataUrl: metadataMatch?.[1]
      ? assertSafeOutboundUrl(metadataMatch[1]).toString()
      : undefined,
    scope: scopeMatch?.[1],
  };
}

async function tryFetchOAuthMetadata(metadataUrl: string, fetcher: Fetcher) {
  try {
    const response = await safeFetch(metadataUrl, { headers: SAFE_FETCH_HEADERS }, fetcher);
    if (!response.ok) return undefined;
    return await readBoundedJson<OAuthServerMetadata>(
      response,
      MAX_DISCOVERY_BYTES,
      "MCP OAuth discovery response is too large.",
    );
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) throw error;
    return undefined;
  }
}

function toDiscoveredOAuthServer(
  metadata: OAuthServerMetadata,
  resource: string,
  resourceScopes: string[],
  expectedIssuer?: URL,
): DiscoveredOAuthServer {
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new ApiError(422, "OAuth metadata is missing required endpoints.");
  }

  if (
    expectedIssuer &&
    metadata.issuer &&
    normalizeIssuer(metadata.issuer) !== normalizeIssuer(expectedIssuer.toString())
  ) {
    throw new ApiError(422, "OAuth metadata issuer did not match the advertised server.");
  }

  return {
    issuer: metadata.issuer ? assertSafeOutboundUrl(metadata.issuer).toString() : undefined,
    authorizationEndpoint: assertSafeOutboundUrl(metadata.authorization_endpoint).toString(),
    tokenEndpoint: assertSafeOutboundUrl(metadata.token_endpoint).toString(),
    registrationEndpoint: metadata.registration_endpoint
      ? assertSafeOutboundUrl(metadata.registration_endpoint).toString()
      : undefined,
    scopesSupported: [
      ...new Set([...resourceScopes, ...validateDiscoveredScopes(metadata.scopes_supported)]),
    ],
    resource,
  };
}

async function safeFetch(input: string, init: RequestInit = {}, fetcher: Fetcher = fetch) {
  assertSafeOutboundUrl(input);
  const response = await fetcher(input, {
    ...init,
    redirect: "manual",
    signal: init.signal ?? AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  if (isRedirect(response.status)) {
    throw new ApiError(400, "Redirects are not followed for MCP server requests.");
  }
  return response;
}

function isRedirect(status: number) {
  return status >= 300 && status < 400;
}

function sanitizeScope(scope: string | undefined, supportedScopes: string[]) {
  const requested = parseScope(scope);

  if (!requested.length) return supportedScopes.length ? supportedScopes.join(" ") : undefined;
  if (!supportedScopes.length) return requested.join(" ");

  const supported = new Set(supportedScopes);
  const allowed = requested.filter((item) => supported.has(item));
  if (!allowed.length) {
    throw new ApiError(400, "None of the requested OAuth scopes are supported by this server.");
  }
  return allowed.join(" ");
}

function normalizeConnectionName(name: string | undefined, serverUrl: string) {
  const trimmed = typeof name === "string" ? name.trim() : undefined;
  if (trimmed) return trimmed.slice(0, 80);
  return new URL(serverUrl).hostname;
}

function buildAuthorizationMetadataUrls(issuer: URL) {
  const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  return [
    new URL(`/.well-known/oauth-authorization-server${issuerPath}`, issuer.origin).toString(),
    new URL(`${issuerPath}/.well-known/openid-configuration`, issuer.origin).toString(),
    new URL(`/.well-known/openid-configuration${issuerPath}`, issuer.origin).toString(),
  ];
}

function normalizeIssuer(value: string) {
  const issuer = assertSafeOutboundUrl(value);
  issuer.hash = "";
  issuer.search = "";
  issuer.pathname = issuer.pathname.replace(/\/$/, "") || "/";
  return issuer.toString();
}

function parseScope(value: string | undefined) {
  if (!value?.trim()) return [];
  if (value.length > 512) throw new ApiError(400, "OAuth scopes are too long.");

  const scopes = [...new Set(value.trim().split(/\s+/))];
  if (scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,64}$/.test(scope))) {
    throw new ApiError(400, "OAuth scopes contain unsupported characters.");
  }
  return scopes;
}

function validateDiscoveredScopes(value: unknown) {
  if (!Array.isArray(value)) return [];
  const scopes = value.filter((scope): scope is string => typeof scope === "string");
  if (scopes.length !== value.length) {
    throw new ApiError(422, "OAuth discovery returned invalid scope metadata.");
  }
  return parseScope(scopes.join(" "));
}

function isSafeToken(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

async function readBoundedJson<T>(response: Response, maxBytes: number, tooLargeMessage: string) {
  if (!response.body) throw new ApiError(502, "MCP server returned an empty response.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError(502, tooLargeMessage);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new ApiError(502, "MCP server returned invalid JSON.");
  }
}

function getTrustedOrigin(env: McpEnv, requestOrigin: string) {
  let configuredOrigin: string;
  try {
    configuredOrigin = new URL(env.BETTER_AUTH_URL).origin;
  } catch {
    throw new ApiError(500, "Application authentication URL is not configured.");
  }
  if (new URL(requestOrigin).origin !== configuredOrigin) {
    throw new ApiError(403, "MCP OAuth must start from the configured application origin.");
  }
  return configuredOrigin;
}

async function hashOAuthState(state: string) {
  if (typeof state !== "string" || state.length < 20 || state.length > 512) {
    throw new ApiError(400, "OAuth session expired. Start the MCP connection again.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  return bytesToBase64Url(new Uint8Array(digest));
}

function isUnsafeHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  );
}

function isPrivateIpLiteral(hostname: string) {
  if (hostname.includes(":")) {
    return (
      hostname === "::1" ||
      hostname === "::" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("fe80:")
    );
  }

  const parts = hostname.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function randomUrlToken(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function pkceChallenge(codeVerifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function getEncryptionKey(secret: string) {
  if (!secret || secret.length < 32) {
    throw new ApiError(500, "MCP auth encryption is not configured.");
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(secret: string, value: unknown) {
  const key = await getEncryptionKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  return JSON.stringify({
    v: 1,
    alg: "AES-GCM",
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
}

export async function decryptJson<T>(secret: string, envelopeJson: string): Promise<T> {
  const envelope = JSON.parse(envelopeJson) as {
    v: number;
    alg: string;
    iv: string;
    ciphertext: string;
  };
  if (envelope.v !== 1 || envelope.alg !== "AES-GCM") {
    throw new ApiError(500, "Unsupported MCP auth encryption envelope.");
  }

  const key = await getEncryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv) },
    key,
    base64UrlToBytes(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
