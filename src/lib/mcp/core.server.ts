import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { getDb } from "#/db";
import { mcpOAuthState, mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { getBillingSummary, hasEntitlement } from "#/lib/billing/core.server";
import type { BillingEnv } from "#/lib/billing/config.server";
import {
  buildAuthorizationUrl,
  createPkcePair,
  discoverOAuthMetadata,
  selectOAuthScopes,
  selectTokenAuthMethod,
  type OAuthMetadata,
} from "./oauth.server";
import {
  decryptJson,
  encryptJson,
  MCP_PROTOCOL_VERSION,
  normalizeMcpServerUrl,
  readBoundedJson,
  readBoundedText,
  safeOutboundFetch,
  type OutboundRequestOptions,
} from "./security.server";

export {
  buildAuthorizationUrl,
  createPkcePair,
  decryptJson,
  discoverOAuthMetadata,
  encryptJson,
  normalizeMcpServerUrl,
};
export type { OAuthMetadata };

const FREE_MCP_SERVER_LIMIT = 3;
const ACTIVE_MCP_STATUSES = ["connected", "pending_auth", "needs_reconnect", "error"] as const;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface McpEnv extends BillingEnv {
  MCP_AUTH_ENCRYPTION_KEY: string;
  MCP_OAUTH_CLIENT_ID?: string;
  MCP_OAUTH_CLIENT_SECRET?: string;
}

export type McpServerStatus =
  | "connected"
  | "pending_auth"
  | "needs_reconnect"
  | "error"
  | "disconnected";

interface McpTokenData {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  obtained_at?: number;
  [key: string]: unknown;
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function encodeBasicClientCredentials(clientId: string, clientSecret: string) {
  const encode = (value: string) =>
    new URLSearchParams({ value }).toString().slice("value=".length);
  return `Basic ${btoa(`${encode(clientId)}:${encode(clientSecret)}`)}`;
}

export function assertCanCreateMcpServer(options: {
  activeServerCount: number;
  hasUnlimitedServers: boolean;
}) {
  if (!options.hasUnlimitedServers && options.activeServerCount >= FREE_MCP_SERVER_LIMIT) {
    throw new ApiError(403, "Free plans can connect up to 3 MCP servers", {
      limit: FREE_MCP_SERVER_LIMIT,
    });
  }
}

export function assertMcpServerOwner<T extends { userId: string }>(
  server: T | undefined,
  userId: string,
): asserts server is T {
  if (!server || server.userId !== userId) {
    throw new ApiError(404, "MCP server not found");
  }
}

function serializeServer(row: typeof mcpServer.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    serverUrl: row.serverUrl,
    status: row.status as McpServerStatus,
    oauthIssuer: row.oauthIssuer,
    scopes: row.scopes,
    lastTestStatus: row.lastTestStatus,
    lastError: row.lastError,
    lastTestAt: row.lastTestAt,
    connectedAt: row.connectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getMcpDashboard(env: McpEnv, userId: string) {
  const db = getDb(env.DB);
  const [billing, unlimited, servers, countResult] = await Promise.all([
    getBillingSummary(env, userId),
    hasEntitlement(env, userId, "unlimited_mcp_servers"),
    db.query.mcpServer.findMany({
      where: eq(mcpServer.userId, userId),
      orderBy: [desc(mcpServer.updatedAt)],
    }),
    db
      .select({ count: sql<number>`count(*)` })
      .from(mcpServer)
      .where(
        and(eq(mcpServer.userId, userId), inArray(mcpServer.status, [...ACTIVE_MCP_STATUSES])),
      ),
  ]);

  const activeCount = Number(countResult[0]?.count ?? 0);
  return {
    plan: billing.plan,
    limit: unlimited ? null : FREE_MCP_SERVER_LIMIT,
    activeCount,
    remaining: unlimited ? null : Math.max(FREE_MCP_SERVER_LIMIT - activeCount, 0),
    servers: servers.map(serializeServer),
  };
}

export async function previewMcpDiscovery(
  serverUrl: string,
  dependencies: OutboundRequestOptions = {},
) {
  const discovery = await discoverOAuthMetadata(serverUrl, dependencies);
  return {
    serverUrl: discovery.serverUrl,
    issuer: discovery.metadata.issuer,
    authorizationEndpoint: discovery.metadata.authorization_endpoint,
    tokenEndpoint: discovery.metadata.token_endpoint,
    scopesSupported: discovery.metadata.scopes_supported ?? [],
  };
}

async function reservePendingServer(
  env: McpEnv,
  userId: string,
  input: {
    existingServer?: typeof mcpServer.$inferSelect;
    name: string;
    serverUrl: string;
    scopes?: string;
    tokenAuthMethod: string;
    metadata: OAuthMetadata;
  },
) {
  const unlimited = await hasEntitlement(env, userId, "unlimited_mcp_servers");
  const now = Math.floor(Date.now() / 1_000);
  const serverId = input.existingServer?.id ?? createId("mcp");
  const activeStatuses = [...ACTIVE_MCP_STATUSES];
  const statusPlaceholders = activeStatuses.map(() => "?").join(", ");

  try {
    const statement = input.existingServer
      ? env.DB.prepare(
          `UPDATE mcp_server
             SET name = ?, server_url = ?, status = 'pending_auth', oauth_issuer = ?,
                 authorization_endpoint = ?, token_endpoint = ?, token_auth_method = ?, scopes = ?,
                 last_error = NULL,
                 updated_at = ?
           WHERE id = ? AND user_id = ?
             AND (status != 'disconnected' OR ? = 1 OR
                  (SELECT COUNT(*) FROM mcp_server
                   WHERE user_id = ? AND status IN (${statusPlaceholders})) < ?)`,
        ).bind(
          input.name,
          input.serverUrl,
          input.metadata.issuer,
          input.metadata.authorization_endpoint,
          input.metadata.token_endpoint,
          input.tokenAuthMethod,
          input.scopes ?? null,
          now,
          serverId,
          userId,
          unlimited ? 1 : 0,
          userId,
          ...activeStatuses,
          FREE_MCP_SERVER_LIMIT,
        )
      : env.DB.prepare(
          `INSERT INTO mcp_server
             (id, user_id, name, server_url, status, oauth_issuer, authorization_endpoint,
              token_endpoint, token_auth_method, scopes, last_error, created_at, updated_at)
           SELECT ?, ?, ?, ?, 'pending_auth', ?, ?, ?, ?, ?, NULL, ?, ?
           WHERE ? = 1
              OR EXISTS (SELECT 1 FROM mcp_server
                         WHERE user_id = ? AND server_url = ?
                           AND status IN (${statusPlaceholders}))
              OR (SELECT COUNT(*) FROM mcp_server
                  WHERE user_id = ? AND status IN (${statusPlaceholders})) < ?
           ON CONFLICT(user_id, server_url) DO UPDATE SET
             name = excluded.name,
             status = 'pending_auth',
             oauth_issuer = excluded.oauth_issuer,
             authorization_endpoint = excluded.authorization_endpoint,
             token_endpoint = excluded.token_endpoint,
             token_auth_method = excluded.token_auth_method,
             scopes = excluded.scopes,
             last_error = NULL,
             updated_at = excluded.updated_at`,
        ).bind(
          serverId,
          userId,
          input.name,
          input.serverUrl,
          input.metadata.issuer,
          input.metadata.authorization_endpoint,
          input.metadata.token_endpoint,
          input.tokenAuthMethod,
          input.scopes ?? null,
          now,
          now,
          unlimited ? 1 : 0,
          userId,
          input.serverUrl,
          ...activeStatuses,
          userId,
          ...activeStatuses,
          FREE_MCP_SERVER_LIMIT,
        );

    const result = await statement.run();
    if (result.meta.changes === 0) {
      throw new ApiError(403, "Free plans can connect up to 3 MCP servers", {
        limit: FREE_MCP_SERVER_LIMIT,
      });
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && /unique|constraint/i.test(error.message)) {
      throw new ApiError(409, "This MCP server URL is already configured");
    }
    throw error;
  }

  const pendingServer = await getDb(env.DB).query.mcpServer.findFirst({
    where: and(eq(mcpServer.userId, userId), eq(mcpServer.serverUrl, input.serverUrl)),
  });
  if (!pendingServer) throw new ApiError(500, "Unable to prepare MCP server connection");
  return pendingServer;
}

export async function startMcpAuthorization(
  env: McpEnv,
  userId: string,
  input: {
    name: string;
    serverUrl: string;
    scopes?: string;
    serverId?: string;
    origin: string;
  },
  dependencies: OutboundRequestOptions = {},
) {
  if (!env.MCP_OAUTH_CLIENT_ID) {
    throw new ApiError(500, "MCP OAuth client ID is not configured");
  }

  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) {
    throw new ApiError(400, "MCP server name must be between 2 and 80 characters");
  }

  const db = getDb(env.DB);
  let existingServer: typeof mcpServer.$inferSelect | undefined;
  if (input.serverId) {
    existingServer = await db.query.mcpServer.findFirst({
      where: eq(mcpServer.id, input.serverId),
    });
    assertMcpServerOwner(existingServer, userId);
  }

  const { serverUrl, metadata } = await discoverOAuthMetadata(input.serverUrl, dependencies);
  const redirectUri = new URL("/api/mcp/auth/callback", input.origin).toString();
  const state = createId("mcpstate");
  const pkce = await createPkcePair();
  const scopes = selectOAuthScopes(metadata, input.scopes);
  const tokenAuthMethod = selectTokenAuthMethod(metadata, !!env.MCP_OAUTH_CLIENT_SECRET);
  const encryptedCodeVerifier = await encryptJson(
    { verifier: pkce.verifier },
    env.MCP_AUTH_ENCRYPTION_KEY,
    `mcp-oauth-state:${state}`,
  );
  const pendingServer = await reservePendingServer(env, userId, {
    existingServer,
    name,
    serverUrl,
    scopes,
    tokenAuthMethod,
    metadata,
  });

  await db
    .delete(mcpOAuthState)
    .where(and(eq(mcpOAuthState.userId, userId), eq(mcpOAuthState.serverId, pendingServer.id)));
  await db.insert(mcpOAuthState).values({
    id: state,
    userId,
    serverId: pendingServer.id,
    serverName: name,
    serverUrl,
    redirectUri,
    scopes: scopes ?? null,
    oauthMetadata: JSON.stringify(metadata),
    encryptedCodeVerifier,
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });

  return {
    authorizationUrl: buildAuthorizationUrl({
      metadata,
      clientId: env.MCP_OAUTH_CLIENT_ID,
      redirectUri,
      state,
      codeChallenge: pkce.challenge,
      scopes,
    }),
    server: serializeServer(pendingServer),
  };
}

async function exchangeAuthorizationCode(
  env: McpEnv,
  metadata: OAuthMetadata,
  request: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
  dependencies: OutboundRequestOptions = {},
) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: env.MCP_OAUTH_CLIENT_ID ?? "",
    code_verifier: request.codeVerifier,
    resource: metadata.resource,
  });

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };

  const tokenAuthMethod = selectTokenAuthMethod(metadata, !!env.MCP_OAUTH_CLIENT_SECRET);
  if (tokenAuthMethod === "client_secret_post") {
    form.set("client_secret", env.MCP_OAUTH_CLIENT_SECRET ?? "");
  } else if (tokenAuthMethod === "client_secret_basic") {
    headers.authorization = encodeBasicClientCredentials(
      env.MCP_OAUTH_CLIENT_ID ?? "",
      env.MCP_OAUTH_CLIENT_SECRET ?? "",
    );
  }

  const response = await safeOutboundFetch(
    metadata.token_endpoint,
    { method: "POST", headers, body: form },
    dependencies,
  );

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ApiError(502, "OAuth token exchange redirects are not allowed");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(502, "OAuth token exchange failed", { status: response.status });
  }

  const tokenData = (await readBoundedJson(response)) as McpTokenData;
  if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
    throw new ApiError(502, "OAuth token response did not include an access token");
  }
  if (tokenData.token_type && tokenData.token_type.toLowerCase() !== "bearer") {
    throw new ApiError(502, "OAuth token response used an unsupported token type");
  }
  return {
    access_token: tokenData.access_token,
    refresh_token:
      typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : undefined,
    token_type: "Bearer",
    expires_in:
      typeof tokenData.expires_in === "number" && tokenData.expires_in > 0
        ? tokenData.expires_in
        : undefined,
    scope: typeof tokenData.scope === "string" ? tokenData.scope : undefined,
    obtained_at: Date.now(),
  } satisfies McpTokenData;
}

export async function completeMcpAuthorization(
  env: McpEnv,
  userId: string,
  input: {
    state: string;
    code: string;
    redirectUri: string;
  },
  dependencies: OutboundRequestOptions = {},
) {
  const db = getDb(env.DB);
  const [pending] = await db
    .delete(mcpOAuthState)
    .where(
      and(
        eq(mcpOAuthState.id, input.state),
        eq(mcpOAuthState.userId, userId),
        eq(mcpOAuthState.redirectUri, input.redirectUri),
        gt(mcpOAuthState.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!pending) throw new ApiError(400, "MCP OAuth state is invalid or expired");

  const metadata = JSON.parse(pending.oauthMetadata) as OAuthMetadata;
  const { verifier } = await decryptJson<{ verifier: string }>(
    pending.encryptedCodeVerifier,
    env.MCP_AUTH_ENCRYPTION_KEY,
    `mcp-oauth-state:${pending.id}`,
  );
  const tokenData = await exchangeAuthorizationCode(
    env,
    metadata,
    {
      code: input.code,
      redirectUri: pending.redirectUri,
      codeVerifier: verifier,
    },
    dependencies,
  );
  if (!pending.serverId) throw new ApiError(400, "MCP OAuth state is invalid or expired");
  const encryptedAuthData = await encryptJson(
    tokenData,
    env.MCP_AUTH_ENCRYPTION_KEY,
    `mcp-server-auth:${pending.serverId}`,
  );

  const [connected] = await db
    .update(mcpServer)
    .set({
      status: "connected",
      encryptedAuthData,
      oauthIssuer: metadata.issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      lastError: null,
      connectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, pending.serverId), eq(mcpServer.userId, userId)))
    .returning({ id: mcpServer.id });
  if (!connected) throw new ApiError(404, "MCP server not found");
}

export async function failMcpAuthorization(env: McpEnv, userId: string, state: string) {
  const db = getDb(env.DB);
  const [pending] = await db
    .delete(mcpOAuthState)
    .where(and(eq(mcpOAuthState.id, state), eq(mcpOAuthState.userId, userId)))
    .returning({ serverId: mcpOAuthState.serverId });
  if (!pending?.serverId) return;

  await db
    .update(mcpServer)
    .set({
      status: "error",
      lastError: "Authorization was declined or cancelled.",
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, pending.serverId), eq(mcpServer.userId, userId)));
}

export async function updateMcpServer(
  env: McpEnv,
  userId: string,
  input: {
    id: string;
    name: string;
    serverUrl: string;
  },
) {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, input.id) });
  assertMcpServerOwner(server, userId);

  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) {
    throw new ApiError(400, "MCP server name must be between 2 and 80 characters");
  }
  const serverUrl = normalizeMcpServerUrl(input.serverUrl);
  const urlChanged = server.serverUrl !== serverUrl;

  try {
    if (urlChanged) {
      await db.batch([
        db
          .delete(mcpOAuthState)
          .where(and(eq(mcpOAuthState.userId, userId), eq(mcpOAuthState.serverId, input.id))),
        db
          .update(mcpServer)
          .set({
            name,
            serverUrl,
            status: "needs_reconnect",
            encryptedAuthData: null,
            lastError: "Server URL changed. Reconnect to authenticate this endpoint.",
            updatedAt: new Date(),
          })
          .where(and(eq(mcpServer.id, input.id), eq(mcpServer.userId, userId))),
      ]);
    } else {
      await db
        .update(mcpServer)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(mcpServer.id, input.id), eq(mcpServer.userId, userId)));
    }
  } catch (error) {
    if (error instanceof Error && /unique|constraint/i.test(error.message)) {
      throw new ApiError(409, "This MCP server URL is already configured");
    }
    throw error;
  }

  const updated = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, input.id) });
  if (!updated) throw new ApiError(404, "MCP server not found");
  return serializeServer(updated);
}

export async function disconnectMcpServer(env: McpEnv, userId: string, id: string) {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
  assertMcpServerOwner(server, userId);

  await db.batch([
    db
      .delete(mcpOAuthState)
      .where(and(eq(mcpOAuthState.userId, userId), eq(mcpOAuthState.serverId, id))),
    db
      .update(mcpServer)
      .set({
        status: "disconnected",
        encryptedAuthData: null,
        lastTestStatus: null,
        lastError: null,
        connectedAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(mcpServer.id, id), eq(mcpServer.userId, userId))),
  ]);

  const updated = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
  if (!updated) throw new ApiError(404, "MCP server not found");
  return serializeServer(updated);
}

export function tokenNeedsRefresh(token: McpTokenData, now = Date.now()) {
  if (!token.expires_in || !token.obtained_at) return false;
  return token.obtained_at + token.expires_in * 1_000 <= now + 60_000;
}

async function refreshTokenData(
  env: McpEnv,
  server: typeof mcpServer.$inferSelect,
  token: McpTokenData,
  dependencies: OutboundRequestOptions,
) {
  if (!token.refresh_token || !server.tokenEndpoint) {
    throw new ApiError(409, "Reconnect this MCP server to renew authorization");
  }

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: env.MCP_OAUTH_CLIENT_ID ?? "",
    resource: server.serverUrl,
  });
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  if (server.tokenAuthMethod === "client_secret_post") {
    form.set("client_secret", env.MCP_OAUTH_CLIENT_SECRET ?? "");
  } else if (server.tokenAuthMethod === "client_secret_basic") {
    headers.authorization = encodeBasicClientCredentials(
      env.MCP_OAUTH_CLIENT_ID ?? "",
      env.MCP_OAUTH_CLIENT_SECRET ?? "",
    );
  }

  const response = await safeOutboundFetch(
    server.tokenEndpoint,
    { method: "POST", headers, body: form },
    dependencies,
  );
  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new ApiError(409, "Reconnect this MCP server to renew authorization");
  }
  const refreshed = (await readBoundedJson(response)) as McpTokenData;
  if (typeof refreshed.access_token !== "string" || !refreshed.access_token) {
    throw new ApiError(409, "Reconnect this MCP server to renew authorization");
  }
  if (refreshed.token_type && refreshed.token_type.toLowerCase() !== "bearer") {
    throw new ApiError(409, "Reconnect this MCP server to renew authorization");
  }

  return {
    access_token: refreshed.access_token,
    refresh_token:
      typeof refreshed.refresh_token === "string" ? refreshed.refresh_token : token.refresh_token,
    token_type: "Bearer",
    expires_in:
      typeof refreshed.expires_in === "number" && refreshed.expires_in > 0
        ? refreshed.expires_in
        : token.expires_in,
    scope: typeof refreshed.scope === "string" ? refreshed.scope : token.scope,
    obtained_at: Date.now(),
  } satisfies McpTokenData;
}

async function getUsableTokenData(
  env: McpEnv,
  server: typeof mcpServer.$inferSelect,
  dependencies: OutboundRequestOptions,
) {
  if (!server.encryptedAuthData || server.status !== "connected") {
    throw new ApiError(409, "Reconnect this MCP server before using it");
  }
  let token = await decryptJson<McpTokenData>(
    server.encryptedAuthData,
    env.MCP_AUTH_ENCRYPTION_KEY,
    `mcp-server-auth:${server.id}`,
  );
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new ApiError(409, "Reconnect this MCP server before using it");
  }

  if (tokenNeedsRefresh(token)) {
    try {
      token = await refreshTokenData(env, server, token, dependencies);
      await getDb(env.DB)
        .update(mcpServer)
        .set({
          status: "connected",
          encryptedAuthData: await encryptJson(
            token,
            env.MCP_AUTH_ENCRYPTION_KEY,
            `mcp-server-auth:${server.id}`,
          ),
          updatedAt: new Date(),
        })
        .where(and(eq(mcpServer.id, server.id), eq(mcpServer.userId, server.userId)));
    } catch {
      await getDb(env.DB)
        .update(mcpServer)
        .set({
          status: "needs_reconnect",
          lastError: "Authorization expired. Reconnect to continue using this server.",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mcpServer.id, server.id),
            eq(mcpServer.userId, server.userId),
            eq(mcpServer.encryptedAuthData, server.encryptedAuthData),
          ),
        );
      const latest = await getDb(env.DB).query.mcpServer.findFirst({
        where: and(eq(mcpServer.id, server.id), eq(mcpServer.userId, server.userId)),
      });
      if (
        latest?.status === "connected" &&
        latest.encryptedAuthData &&
        latest.encryptedAuthData !== server.encryptedAuthData
      ) {
        return decryptJson<McpTokenData>(
          latest.encryptedAuthData,
          env.MCP_AUTH_ENCRYPTION_KEY,
          `mcp-server-auth:${server.id}`,
        );
      }
      throw new ApiError(409, "Reconnect this MCP server to renew authorization");
    }
  }
  return token;
}

async function parseInitializeResponse(response: Response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  let payload: unknown;
  if (contentType.includes("text/event-stream")) {
    const text = await readBoundedText(response);
    const data = text
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
      ?.slice(5)
      .trim();
    if (!data) throw new ApiError(502, "MCP server returned an invalid initialization response");
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      throw new ApiError(502, "MCP server returned an invalid initialization response");
    }
  } else {
    payload = await readBoundedJson(response);
  }

  if (!payload || typeof payload !== "object") {
    throw new ApiError(502, "MCP server returned an invalid initialization response");
  }
  const body = payload as Record<string, unknown>;
  if (body.jsonrpc !== "2.0" || body.id !== "connection-test" || !body.result) {
    throw new ApiError(502, "MCP server did not complete protocol initialization");
  }
}

export async function testMcpServerConnection(
  env: McpEnv,
  userId: string,
  id: string,
  dependencies: OutboundRequestOptions = {},
) {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
  assertMcpServerOwner(server, userId);

  const now = new Date();
  try {
    const tokenData = await getUsableTokenData(env, server, dependencies);
    const response = await safeOutboundFetch(
      server.serverUrl,
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${tokenData.access_token}`,
          "content-type": "application/json",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "connection-test",
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "Tendon", version: "1.0.0" },
          },
        }),
      },
      dependencies,
    );
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ApiError(502, "MCP server test returned an unsafe redirect");
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      await db
        .update(mcpServer)
        .set({
          status: "needs_reconnect",
          lastTestAt: now,
          lastTestStatus: "failed",
          lastError: "Authorization was rejected. Reconnect to continue.",
          updatedAt: now,
        })
        .where(and(eq(mcpServer.id, id), eq(mcpServer.userId, userId)));
      throw new ApiError(409, "MCP server authorization needs to be renewed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(502, `MCP server test failed with HTTP ${response.status}`);
    }
    await parseInitializeResponse(response);

    await db
      .update(mcpServer)
      .set({
        lastTestAt: now,
        lastTestStatus: "ok",
        lastError: null,
        updatedAt: now,
      })
      .where(and(eq(mcpServer.id, id), eq(mcpServer.userId, userId)));
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) {
      await db
        .update(mcpServer)
        .set({
          lastTestAt: now,
          lastTestStatus: "failed",
          lastError: "Connection test failed. Check the endpoint and try again.",
          updatedAt: now,
        })
        .where(and(eq(mcpServer.id, id), eq(mcpServer.userId, userId)));
    }
    throw error;
  }

  const updated = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
  if (!updated) throw new ApiError(404, "MCP server not found");
  return serializeServer(updated);
}

/**
 * Server-only integration point for chat runtimes. Never serialize this return value to a client.
 */
export async function getConnectedMcpServersForChat(
  env: McpEnv,
  userId: string,
  dependencies: OutboundRequestOptions = {},
) {
  const servers = await getDb(env.DB).query.mcpServer.findMany({
    where: and(eq(mcpServer.userId, userId), eq(mcpServer.status, "connected")),
  });

  const connections = await Promise.all(
    servers.map(async (server) => {
      try {
        const token = await getUsableTokenData(env, server, dependencies);
        return {
          id: server.id,
          name: server.name,
          serverUrl: server.serverUrl,
          headers: { authorization: `Bearer ${token.access_token}` },
        };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) return null;
        throw error;
      }
    }),
  );
  return connections.filter((connection) => connection !== null);
}
