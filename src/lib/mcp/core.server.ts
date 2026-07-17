import { and, desc, eq, lt } from "drizzle-orm";

import { getDb } from "#/db";
import { mcpConnection, mcpOauthSession } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import type { BillingEnv } from "#/lib/billing/config.server";
import { hasEntitlement } from "#/lib/billing/core.server";
import {
  credentialAdditionalData,
  decryptJson,
  encryptJson,
  oauthAdditionalData,
  sha256Base64Url,
} from "./crypto.server";
import { MCP_CONNECTION_INSERT_SQL, McpConnectionLimitError } from "./limits";
import { safeExternalFetch } from "./network.server";
import { discoverMcpOAuth, prepareOAuth, requestToken } from "./oauth.server";
import { canonicalizeMcpServerUrl } from "./security";
import {
  FREE_MCP_SERVER_LIMIT,
  type McpConnectionDto,
  type McpCredentials,
  type McpOauthPayload,
} from "./types";

export type McpEnv = BillingEnv & { MCP_CREDENTIALS_ENCRYPTION_KEY: string };

const OAUTH_SESSION_TTL_MS = 10 * 60 * 1_000;

type ConnectionRow = typeof mcpConnection.$inferSelect;

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function errorCode(error: unknown) {
  return error instanceof ApiError && typeof error.details?.code === "string"
    ? error.details.code
    : "connection_failed";
}

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

export function toMcpConnectionDto(connection: ConnectionRow): McpConnectionDto {
  return {
    id: connection.id,
    name: connection.name,
    serverUrl: connection.serverUrl,
    status:
      connection.status === "connected" || connection.status === "error"
        ? connection.status
        : "pending",
    authType: connection.authType === "none" ? "none" : "oauth",
    lastErrorCode: connection.lastErrorCode,
    lastTestedAt: iso(connection.lastTestedAt),
    lastConnectedAt: iso(connection.lastConnectedAt),
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

export function assertConnectionOwner<T extends Pick<ConnectionRow, "userId">>(
  connection: T | undefined,
  userId: string,
): asserts connection is T {
  if (!connection || connection.userId !== userId) {
    throw new ApiError(404, "MCP server connection not found", {
      code: "connection_not_found",
    });
  }
}

export async function getOwnedConnection(env: McpEnv, userId: string, connectionId: string) {
  const connection = await getDb(env.DB).query.mcpConnection.findFirst({
    where: and(eq(mcpConnection.id, connectionId), eq(mcpConnection.userId, userId)),
  });
  assertConnectionOwner(connection, userId);
  return connection;
}

export async function listMcpConnections(env: McpEnv, userId: string) {
  const db = getDb(env.DB);
  const [connections, unlimited] = await Promise.all([
    db.query.mcpConnection.findMany({
      where: eq(mcpConnection.userId, userId),
      orderBy: [desc(mcpConnection.createdAt)],
    }),
    hasEntitlement(env, userId, "unlimited_mcp_servers"),
  ]);
  return {
    connections: connections.map(toMcpConnectionDto),
    limits: {
      used: connections.length,
      maximum: unlimited ? null : FREE_MCP_SERVER_LIMIT,
      unlimited,
    },
  };
}

async function markConnectionError(env: McpEnv, connectionId: string, error: unknown) {
  await getDb(env.DB)
    .update(mcpConnection)
    .set({ status: "error", lastErrorCode: errorCode(error), updatedAt: new Date() })
    .where(eq(mcpConnection.id, connectionId));
}

async function beginConnection(env: McpEnv, connection: ConnectionRow, appOrigin: string) {
  try {
    const discovery = await discoverMcpOAuth(connection.serverUrl);
    const db = getDb(env.DB);
    if (discovery.authType === "none") {
      const now = new Date();
      await db
        .update(mcpConnection)
        .set({
          status: "connected",
          authType: "none",
          credentialsEncrypted: null,
          lastErrorCode: null,
          lastConnectedAt: now,
          lastTestedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(mcpConnection.id, connection.id), eq(mcpConnection.userId, connection.userId)),
        );
      return {
        connection: toMcpConnectionDto(
          await getOwnedConnection(env, connection.userId, connection.id),
        ),
        connected: true as const,
      };
    }

    const oauth = await prepareOAuth(discovery, appOrigin);
    const payload: McpOauthPayload = {
      version: 1,
      codeVerifier: oauth.codeVerifier,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      tokenEndpoint: oauth.tokenEndpoint,
      tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod,
      redirectUri: oauth.redirectUri,
      resource: oauth.resource,
    };
    const sessionId = createId("mcp_oauth");
    const encrypted = await encryptJson(
      payload,
      env.MCP_CREDENTIALS_ENCRYPTION_KEY,
      oauthAdditionalData(connection.userId, connection.id),
    );
    await db.batch([
      db.delete(mcpOauthSession).where(eq(mcpOauthSession.connectionId, connection.id)),
      db.insert(mcpOauthSession).values({
        id: sessionId,
        connectionId: connection.id,
        userId: connection.userId,
        stateHash: oauth.stateHash,
        payloadEncrypted: encrypted,
        expiresAt: new Date(Date.now() + OAUTH_SESSION_TTL_MS),
      }),
      db
        .update(mcpConnection)
        .set({ status: "pending", authType: "oauth", lastErrorCode: null, updatedAt: new Date() })
        .where(
          and(eq(mcpConnection.id, connection.id), eq(mcpConnection.userId, connection.userId)),
        ),
    ]);
    return {
      connection: toMcpConnectionDto(
        await getOwnedConnection(env, connection.userId, connection.id),
      ),
      authorizationUrl: oauth.authorizationUrl,
    };
  } catch (error) {
    await markConnectionError(env, connection.id, error);
    throw error;
  }
}

export async function createMcpConnection(
  env: McpEnv,
  userId: string,
  input: { name: string; serverUrl: string },
  appOrigin: string,
) {
  const serverUrl = canonicalizeMcpServerUrl(input.serverUrl);
  const db = getDb(env.DB);
  const duplicate = await db.query.mcpConnection.findFirst({
    where: and(eq(mcpConnection.userId, userId), eq(mcpConnection.serverUrl, serverUrl)),
  });
  if (duplicate) {
    throw new ApiError(409, "This MCP server is already configured", {
      code: "connection_already_exists",
    });
  }

  const unlimited = await hasEntitlement(env, userId, "unlimited_mcp_servers");
  const connectionId = createId("mcp");
  let result: D1Result;
  try {
    result = await env.DB.prepare(MCP_CONNECTION_INSERT_SQL)
      .bind(connectionId, userId, input.name, serverUrl, unlimited ? 1 : 0)
      .run();
  } catch {
    throw new ApiError(409, "This MCP server is already configured", {
      code: "connection_already_exists",
    });
  }
  if (result.meta.changes === 0) throw new McpConnectionLimitError();

  return beginConnection(env, await getOwnedConnection(env, userId, connectionId), appOrigin);
}

export async function updateMcpConnection(
  env: McpEnv,
  userId: string,
  connectionId: string,
  input: { name: string; serverUrl: string },
  appOrigin: string,
) {
  const existing = await getOwnedConnection(env, userId, connectionId);
  const serverUrl = canonicalizeMcpServerUrl(input.serverUrl);
  const urlChanged = existing.serverUrl !== serverUrl;
  try {
    await getDb(env.DB)
      .update(mcpConnection)
      .set({
        name: input.name,
        serverUrl,
        ...(urlChanged
          ? {
              status: "pending",
              authType: "oauth",
              credentialsEncrypted: null,
              lastErrorCode: null,
              lastConnectedAt: null,
              lastTestedAt: null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(mcpConnection.id, connectionId), eq(mcpConnection.userId, userId)));
  } catch {
    throw new ApiError(409, "This MCP server is already configured", {
      code: "connection_already_exists",
    });
  }
  const updated = await getOwnedConnection(env, userId, connectionId);
  return urlChanged
    ? beginConnection(env, updated, appOrigin)
    : { connection: toMcpConnectionDto(updated) };
}

export async function reconnectMcpConnection(
  env: McpEnv,
  userId: string,
  connectionId: string,
  appOrigin: string,
) {
  return beginConnection(env, await getOwnedConnection(env, userId, connectionId), appOrigin);
}

export async function disconnectMcpConnection(env: McpEnv, userId: string, connectionId: string) {
  await getOwnedConnection(env, userId, connectionId);
  await getDb(env.DB)
    .delete(mcpConnection)
    .where(and(eq(mcpConnection.id, connectionId), eq(mcpConnection.userId, userId)));
}

export async function completeMcpOAuth(env: McpEnv, userId: string, state: string, code: string) {
  const db = getDb(env.DB);
  const stateHash = await sha256Base64Url(state);
  const session = await db.query.mcpOauthSession.findFirst({
    where: and(eq(mcpOauthSession.stateHash, stateHash), eq(mcpOauthSession.userId, userId)),
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    if (session) await db.delete(mcpOauthSession).where(eq(mcpOauthSession.id, session.id));
    throw new ApiError(400, "This MCP authorization request has expired", {
      code: "oauth_session_expired",
    });
  }
  const connection = await getOwnedConnection(env, userId, session.connectionId);
  const payload = await decryptJson<McpOauthPayload>(
    session.payloadEncrypted,
    env.MCP_CREDENTIALS_ENCRYPTION_KEY,
    oauthAdditionalData(userId, connection.id),
  );

  // Consume the state before exchanging the code so a callback cannot be replayed.
  await db.delete(mcpOauthSession).where(eq(mcpOauthSession.id, session.id));
  try {
    const token = await requestToken(payload, {
      type: "authorization_code",
      code,
      codeVerifier: payload.codeVerifier,
      redirectUri: payload.redirectUri,
    });
    const credentials: McpCredentials = {
      version: 1,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      tokenType: "Bearer",
      scope: token.scope,
      expiresAt: token.expiresAt,
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      tokenEndpoint: payload.tokenEndpoint,
      tokenEndpointAuthMethod: payload.tokenEndpointAuthMethod,
      resource: payload.resource,
    };
    const encrypted = await encryptJson(
      credentials,
      env.MCP_CREDENTIALS_ENCRYPTION_KEY,
      credentialAdditionalData(userId, connection.id),
    );
    const now = new Date();
    await db
      .update(mcpConnection)
      .set({
        credentialsEncrypted: encrypted,
        status: "connected",
        authType: "oauth",
        lastErrorCode: null,
        lastConnectedAt: now,
        updatedAt: now,
      })
      .where(and(eq(mcpConnection.id, connection.id), eq(mcpConnection.userId, userId)));
    return connection.id;
  } catch (error) {
    await markConnectionError(env, connection.id, error);
    throw error;
  }
}

export async function failMcpOAuth(env: McpEnv, userId: string, state: string) {
  const db = getDb(env.DB);
  const stateHash = await sha256Base64Url(state);
  const session = await db.query.mcpOauthSession.findFirst({
    where: and(eq(mcpOauthSession.stateHash, stateHash), eq(mcpOauthSession.userId, userId)),
  });
  if (!session) return;

  await db.batch([
    db.delete(mcpOauthSession).where(eq(mcpOauthSession.id, session.id)),
    db
      .update(mcpConnection)
      .set({ status: "error", lastErrorCode: "access_denied", updatedAt: new Date() })
      .where(and(eq(mcpConnection.id, session.connectionId), eq(mcpConnection.userId, userId))),
  ]);
}

async function loadFreshCredentials(env: McpEnv, connection: ConnectionRow) {
  if (!connection.credentialsEncrypted) {
    throw new ApiError(409, "This MCP server needs to be reconnected", {
      code: "mcp_reconnect_required",
    });
  }
  let credentials = await decryptJson<McpCredentials>(
    connection.credentialsEncrypted,
    env.MCP_CREDENTIALS_ENCRYPTION_KEY,
    credentialAdditionalData(connection.userId, connection.id),
  );
  if (!credentials.expiresAt || credentials.expiresAt > Date.now() + 30_000) return credentials;
  if (!credentials.refreshToken) {
    throw new ApiError(401, "MCP authorization has expired", {
      code: "mcp_reconnect_required",
    });
  }

  const refreshed = await requestToken(credentials, {
    type: "refresh_token",
    refreshToken: credentials.refreshToken,
  });
  credentials = {
    ...credentials,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? credentials.refreshToken,
    scope: refreshed.scope ?? credentials.scope,
    expiresAt: refreshed.expiresAt,
  };
  const encrypted = await encryptJson(
    credentials,
    env.MCP_CREDENTIALS_ENCRYPTION_KEY,
    credentialAdditionalData(connection.userId, connection.id),
  );
  await getDb(env.DB)
    .update(mcpConnection)
    .set({ credentialsEncrypted: encrypted, updatedAt: new Date() })
    .where(and(eq(mcpConnection.id, connection.id), eq(mcpConnection.userId, connection.userId)));
  return credentials;
}

export async function mcpFetchForUser(
  env: McpEnv,
  userId: string,
  connectionId: string,
  init: RequestInit,
) {
  const connection = await getOwnedConnection(env, userId, connectionId);
  if (connection.status !== "connected") {
    throw new ApiError(409, "This MCP server is not connected", {
      code: "mcp_not_connected",
    });
  }
  const headers = new Headers(init.headers);
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  if (connection.authType === "oauth") {
    const credentials = await loadFreshCredentials(env, connection);
    headers.set("authorization", `Bearer ${credentials.accessToken}`);
  } else {
    headers.delete("authorization");
  }
  return safeExternalFetch(connection.serverUrl, { ...init, headers });
}

export async function testMcpConnection(env: McpEnv, userId: string, connectionId: string) {
  const connection = await getOwnedConnection(env, userId, connectionId);
  try {
    const response = await mcpFetchForUser(env, userId, connectionId, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "connection-test",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "Tendon", version: "1.0.0" },
        },
      }),
    });
    const ok = response.ok;
    await response.body?.cancel();
    if (!ok) {
      throw new ApiError(response.status === 401 ? 401 : 502, "MCP connection test failed", {
        code: response.status === 401 ? "mcp_reconnect_required" : "mcp_test_failed",
      });
    }
    const now = new Date();
    await getDb(env.DB)
      .update(mcpConnection)
      .set({
        status: "connected",
        lastErrorCode: null,
        lastTestedAt: now,
        updatedAt: now,
      })
      .where(and(eq(mcpConnection.id, connectionId), eq(mcpConnection.userId, userId)));
    return toMcpConnectionDto(await getOwnedConnection(env, userId, connectionId));
  } catch (error) {
    await markConnectionError(env, connection.id, error);
    throw error;
  }
}

export async function deleteExpiredMcpOauthSessions(env: Pick<McpEnv, "DB">) {
  await getDb(env.DB).delete(mcpOauthSession).where(lt(mcpOauthSession.expiresAt, new Date()));
}
