import { and, asc, eq, sql } from "drizzle-orm";

import { getDb, type DB } from "#/db";
import { mcpOauthState, mcpServer, user } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { hasEntitlement } from "#/lib/billing/core.server";
import {
  FREE_MCP_SERVER_LIMIT,
  type McpServerDto,
  type McpServerStatus,
  type McpServerUsage,
} from "./config";
import type { McpApiEnv, McpEnv } from "./config.server";
import { decryptJson, encryptJson } from "./crypto.server";
import { discoverMcpAuth, probeMcpServer, type OAuthServerMetadata } from "./discovery.server";
import {
  buildAuthorizationUrl,
  exchangeCode,
  generatePkce,
  generateState,
  registerClient,
  type TokenSet,
} from "./oauth.server";
import { validateMcpServerUrl } from "./url.server";

type McpCoreEnv = McpApiEnv;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type McpServerRow = typeof mcpServer.$inferSelect;

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_NAME_LENGTH = 80;

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** Serializes a row into the client-safe DTO. Never includes secret material. */
export function toServerDto(row: McpServerRow): McpServerDto {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    status: row.status as McpServerStatus,
    authType: row.authType as McpServerDto["authType"],
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function getOwnedServer(db: DB, userId: string, serverId: string) {
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });

  // 404 for both missing and foreign rows so existence is never leaked.
  if (!row) {
    throw new ApiError(404, "MCP server not found");
  }

  return row;
}

function validateServerName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ApiError(400, "Give the server a name");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, `Server names are limited to ${MAX_NAME_LENGTH} characters`);
  }
  return trimmed;
}

async function getUsage(db: DB, env: McpCoreEnv, userId: string): Promise<McpServerUsage> {
  const unlimited = await hasEntitlement(env, userId, "unlimited_mcp_servers");
  const rows = await db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    columns: { id: true },
  });
  return { count: rows.length, limit: unlimited ? null : FREE_MCP_SERVER_LIMIT };
}

export async function listMcpServers(env: McpCoreEnv, userId: string) {
  const db = getDb(env.DB);
  const rows = await db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    orderBy: [asc(mcpServer.createdAt)],
  });
  const usage = await getUsage(db, env, userId);

  return { servers: rows.map(toServerDto), usage };
}

/**
 * Inserts the server row, enforcing the plan limit atomically. Free users get
 * `INSERT ... SELECT ... WHERE count < limit` so concurrent requests cannot
 * race past the cap; the pro plan skips the guard clause entirely.
 */
async function insertServerRow(
  db: DB,
  env: McpCoreEnv,
  userId: string,
  input: { name: string; url: string },
) {
  const id = createId("mcp");
  const unlimited = await hasEntitlement(env, userId, "unlimited_mcp_servers");

  try {
    if (unlimited) {
      const result = await db
        .insert(mcpServer)
        .values({ id, userId, name: input.name, url: input.url });
      if (result.meta.changes === 0) throw new Error("insert failed");
    } else {
      // drizzle's insert-select requires every table column to be present in
      // the select, so defaults are spelled out explicitly here.
      const result = await db.insert(mcpServer).select(
        db
          .select({
            id: sql<string>`${id}`.as("id"),
            userId: sql<string>`${userId}`.as("user_id"),
            name: sql<string>`${input.name}`.as("name"),
            url: sql<string>`${input.url}`.as("url"),
            status: sql<string>`${"pending_auth"}`.as("status"),
            authType: sql<string>`${"unknown"}`.as("auth_type"),
            encryptedAuth: sql<string | null>`NULL`.as("encrypted_auth"),
            oauthClientId: sql<string | null>`NULL`.as("oauth_client_id"),
            oauthClientSecret: sql<string | null>`NULL`.as("oauth_client_secret"),
            lastTestedAt: sql<Date | null>`NULL`.as("last_tested_at"),
            lastError: sql<string | null>`NULL`.as("last_error"),
            createdAt: sql<Date>`(unixepoch())`.as("created_at"),
            updatedAt: sql<Date>`(unixepoch())`.as("updated_at"),
          })
          .from(user)
          .where(
            and(
              eq(user.id, userId),
              sql`(select count(*) from ${mcpServer} where ${mcpServer.userId} = ${userId}) < ${FREE_MCP_SERVER_LIMIT}`,
            ),
          ),
      );
      if (result.meta.changes === 0) {
        throw new ApiError(
          403,
          `Free accounts can connect up to ${FREE_MCP_SERVER_LIMIT} MCP servers. Upgrade to Pro for unlimited servers.`,
          { code: "limit_reached", limit: FREE_MCP_SERVER_LIMIT },
        );
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // A unique-index violation means the URL is already connected (race-safe).
    if (error instanceof Error && /unique/i.test(error.message)) {
      throw new ApiError(409, "This MCP server is already connected");
    }
    throw error;
  }

  return id;
}

async function assertUrlNotDuplicate(db: DB, userId: string, url: string, excludeId?: string) {
  const existing = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.userId, userId), eq(mcpServer.url, url)),
    columns: { id: true },
  });
  if (existing && existing.id !== excludeId) {
    throw new ApiError(409, "This MCP server is already connected");
  }
}

export function getOAuthCallbackUrl(origin: string) {
  return `${origin}/api/mcp/oauth/callback`;
}

/**
 * Runs discovery and prepares an OAuth authorization attempt for a server row:
 * dynamic client registration, PKCE, and a single-use state record.
 */
async function prepareAuthorization(
  db: DB,
  env: McpEnv,
  userId: string,
  server: { id: string; url: string },
  metadata: OAuthServerMetadata,
  origin: string,
  fetchImpl: FetchLike,
): Promise<string> {
  if (!metadata.registrationEndpoint) {
    throw new ApiError(
      502,
      "The server's authorization server does not support dynamic client registration",
    );
  }

  const redirectUri = getOAuthCallbackUrl(origin);
  const registration = await registerClient(metadata.registrationEndpoint, redirectUri, fetchImpl);
  const { verifier, challenge } = await generatePkce();
  const state = generateState();

  await db.insert(mcpOauthState).values({
    state,
    serverId: server.id,
    userId,
    codeVerifier: await encryptJson(env, verifier),
    clientId: registration.clientId,
    clientSecret: registration.clientSecret
      ? await encryptJson(env, registration.clientSecret)
      : null,
    tokenEndpoint: metadata.tokenEndpoint,
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });

  await db
    .update(mcpServer)
    .set({
      oauthClientId: registration.clientId,
      oauthClientSecret: registration.clientSecret
        ? await encryptJson(env, registration.clientSecret)
        : null,
      updatedAt: new Date(),
    })
    .where(eq(mcpServer.id, server.id));

  return buildAuthorizationUrl(metadata, {
    clientId: registration.clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
    resource: server.url,
  });
}

/**
 * Marks a server as errored without ever storing raw exception details that
 * could contain credential material.
 */
async function recordError(db: DB, serverId: string, message: string) {
  await db
    .update(mcpServer)
    .set({ status: "error", lastError: message, updatedAt: new Date() })
    .where(eq(mcpServer.id, serverId));
}

export interface CreateServerResult {
  server: McpServerDto;
  authorizationUrl: string | null;
}

/**
 * Creates a server row and immediately runs connectivity + auth discovery.
 * Discovery failures are recorded on the row (status "error") and surfaced via
 * the returned DTO so the UI can offer retry without losing the entry.
 */
export async function createServer(
  env: McpCoreEnv,
  userId: string,
  input: { name: string; url: string },
  origin: string,
  fetchImpl: FetchLike = fetch,
): Promise<CreateServerResult> {
  const name = validateServerName(input.name);
  if (input.url.length > 2048) {
    throw new ApiError(400, "The URL is too long");
  }
  const url = validateMcpServerUrl(input.url);

  const db = getDb(env.DB);
  await assertUrlNotDuplicate(db, userId, url);
  const id = await insertServerRow(db, env, userId, { name, url });

  try {
    const discovery = await discoverMcpAuth(url, fetchImpl);
    if (!discovery.requiresAuth) {
      await db
        .update(mcpServer)
        .set({
          status: "connected",
          authType: "none",
          lastTestedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(mcpServer.id, id));
      const row = await getOwnedServer(db, userId, id);
      return { server: toServerDto(row), authorizationUrl: null };
    }

    const authorizationUrl = await prepareAuthorization(
      db,
      env,
      userId,
      { id, url },
      discovery.metadata!,
      origin,
      fetchImpl,
    );
    await db
      .update(mcpServer)
      .set({ status: "pending_auth", authType: "oauth", updatedAt: new Date() })
      .where(eq(mcpServer.id, id));
    const row = await getOwnedServer(db, userId, id);
    return { server: toServerDto(row), authorizationUrl };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Unable to inspect the MCP server";
    await recordError(db, id, message);
    // Remove any partially created authorization attempt.
    await db.delete(mcpOauthState).where(eq(mcpOauthState.serverId, id));
    const row = await getOwnedServer(db, userId, id);
    return { server: toServerDto(row), authorizationUrl: null };
  }
}

/**
 * Re-runs discovery for an existing server and returns a fresh authorization
 * URL. Used by the reconnect flow and to retry failed connection attempts.
 */
export async function beginReauthorization(
  env: McpCoreEnv,
  userId: string,
  serverId: string,
  origin: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ authorizationUrl: string | null; server: McpServerDto }> {
  const db = getDb(env.DB);
  const row = await getOwnedServer(db, userId, serverId);

  try {
    const discovery = await discoverMcpAuth(row.url, fetchImpl);
    if (!discovery.requiresAuth) {
      await db
        .update(mcpServer)
        .set({
          status: "connected",
          authType: "none",
          encryptedAuth: null,
          lastTestedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(mcpServer.id, row.id));
      return {
        authorizationUrl: null,
        server: toServerDto(await getOwnedServer(db, userId, row.id)),
      };
    }

    // Clear stale attempts before issuing a new one.
    await db.delete(mcpOauthState).where(eq(mcpOauthState.serverId, row.id));
    const authorizationUrl = await prepareAuthorization(
      db,
      env,
      userId,
      row,
      discovery.metadata!,
      origin,
      fetchImpl,
    );
    await db
      .update(mcpServer)
      .set({
        status: "pending_auth",
        authType: "oauth",
        encryptedAuth: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(mcpServer.id, row.id));
    return {
      authorizationUrl,
      server: toServerDto(await getOwnedServer(db, userId, row.id)),
    };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Unable to inspect the MCP server";
    await recordError(db, row.id, message);
    return {
      authorizationUrl: null,
      server: toServerDto(await getOwnedServer(db, userId, row.id)),
    };
  }
}

/**
 * Completes the OAuth redirect: validates the single-use state, exchanges the
 * code, encrypts the token set, and marks the server connected.
 */
export async function completeOAuth(
  env: McpCoreEnv,
  userId: string,
  input: { state: string; code: string },
  origin: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const db = getDb(env.DB);
  const stateRow = await db.query.mcpOauthState.findFirst({
    where: eq(mcpOauthState.state, input.state),
  });

  if (!stateRow || stateRow.userId !== userId) {
    throw new ApiError(400, "This sign-in attempt expired. Start the connection again.");
  }

  // Single-use: consume the state before doing anything else.
  await db.delete(mcpOauthState).where(eq(mcpOauthState.state, input.state));

  if (stateRow.expiresAt.getTime() < Date.now()) {
    throw new ApiError(400, "This sign-in attempt expired. Start the connection again.");
  }

  const server = await getOwnedServer(db, userId, stateRow.serverId);
  const verifier = await decryptJson<string>(env, stateRow.codeVerifier);
  const clientSecret = stateRow.clientSecret
    ? await decryptJson<string>(env, stateRow.clientSecret)
    : undefined;

  try {
    const tokens = await exchangeCode(
      stateRow.tokenEndpoint,
      {
        code: input.code,
        verifier,
        clientId: stateRow.clientId,
        clientSecret,
        redirectUri: getOAuthCallbackUrl(origin),
        resource: server.url,
      },
      fetchImpl,
    );

    await db
      .update(mcpServer)
      .set({
        status: "connected",
        authType: "oauth",
        encryptedAuth: await encryptJson(env, tokens),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(mcpServer.id, server.id));
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Unable to complete authorization";
    await db
      .update(mcpServer)
      .set({ status: "reconnect_required", lastError: message, updatedAt: new Date() })
      .where(eq(mcpServer.id, server.id));
    throw error instanceof ApiError ? error : new ApiError(502, "Unable to complete authorization");
  }
}

/** Records a denied/cancelled OAuth attempt so the UI can prompt a reconnect. */
export async function abandonOAuth(env: McpEnv, userId: string, state: string, reason: string) {
  const db = getDb(env.DB);
  const stateRow = await db.query.mcpOauthState.findFirst({
    where: eq(mcpOauthState.state, state),
  });
  if (!stateRow || stateRow.userId !== userId) return;

  await db.delete(mcpOauthState).where(eq(mcpOauthState.state, state));
  await db
    .update(mcpServer)
    .set({ status: "reconnect_required", lastError: reason, updatedAt: new Date() })
    .where(and(eq(mcpServer.id, stateRow.serverId), eq(mcpServer.userId, userId)));
}

/**
 * Renames a server or moves it to a new URL. Changing the URL invalidates the
 * stored credentials and puts the server back into the pending-auth state so
 * the user is guided through re-authorization.
 */
export async function updateServer(
  env: McpCoreEnv,
  userId: string,
  serverId: string,
  input: { name?: string; url?: string },
): Promise<McpServerDto> {
  const db = getDb(env.DB);
  const row = await getOwnedServer(db, userId, serverId);

  const nextName = input.name !== undefined ? validateServerName(input.name) : row.name;
  const nextUrl = input.url !== undefined ? validateMcpServerUrl(input.url) : row.url;
  const urlChanged = nextUrl !== row.url;

  if (urlChanged) {
    await assertUrlNotDuplicate(db, userId, nextUrl, serverId);
    await db.delete(mcpOauthState).where(eq(mcpOauthState.serverId, serverId));
  }

  await db
    .update(mcpServer)
    .set({
      name: nextName,
      url: nextUrl,
      ...(urlChanged
        ? {
            status: "pending_auth",
            authType: "unknown",
            encryptedAuth: null,
            oauthClientId: null,
            oauthClientSecret: null,
            lastError: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));

  return toServerDto(await getOwnedServer(db, userId, serverId));
}

export async function deleteServer(env: McpEnv, userId: string, serverId: string): Promise<void> {
  const db = getDb(env.DB);
  await getOwnedServer(db, userId, serverId);
  await db.delete(mcpServer).where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));
}

export interface TestServerResult {
  ok: boolean;
  server: McpServerDto;
}

/**
 * User-initiated connectivity check. Sends an MCP `initialize` request with the
 * stored credential (when any) and records the outcome. Error details are
 * limited to status codes so response bodies can never leak into the DB/UI.
 */
export async function testServer(
  env: McpCoreEnv,
  userId: string,
  serverId: string,
  fetchImpl: FetchLike = fetch,
): Promise<TestServerResult> {
  const db = getDb(env.DB);
  const row = await getOwnedServer(db, userId, serverId);

  let authHeader: string | undefined;
  if (row.authType === "oauth") {
    if (!row.encryptedAuth) {
      await db
        .update(mcpServer)
        .set({
          status: "reconnect_required",
          lastError: "Authorization is required to reach this server",
          lastTestedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mcpServer.id, row.id));
      return { ok: false, server: toServerDto(await getOwnedServer(db, userId, row.id)) };
    }

    const tokens = await decryptJson<TokenSet>(env, row.encryptedAuth);
    if (tokens.expiresAt && tokens.expiresAt < Date.now()) {
      await db
        .update(mcpServer)
        .set({
          status: "reconnect_required",
          lastError: "The access token expired. Reconnect to continue.",
          lastTestedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mcpServer.id, row.id));
      return { ok: false, server: toServerDto(await getOwnedServer(db, userId, row.id)) };
    }
    authHeader = `${tokens.tokenType} ${tokens.accessToken}`;
  }

  try {
    const response = await probeMcpServer(row.url, fetchImpl, authHeader);
    await response.body?.cancel();

    if (response.status === 401 || response.status === 403) {
      await db
        .update(mcpServer)
        .set({
          status: "reconnect_required",
          lastError: "The server rejected the stored credentials",
          lastTestedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mcpServer.id, row.id));
      return { ok: false, server: toServerDto(await getOwnedServer(db, userId, row.id)) };
    }

    if (response.status >= 500) {
      await db
        .update(mcpServer)
        .set({
          status: "error",
          lastError: `The server responded with status ${response.status}`,
          lastTestedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mcpServer.id, row.id));
      return { ok: false, server: toServerDto(await getOwnedServer(db, userId, row.id)) };
    }

    // Any 2xx/3xx/4xx (other than auth) means the endpoint is reachable and
    // speaking HTTP; MCP-level errors still prove connectivity.
    await db
      .update(mcpServer)
      .set({
        status: "connected",
        lastError: null,
        lastTestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(mcpServer.id, row.id));
    return { ok: true, server: toServerDto(await getOwnedServer(db, userId, row.id)) };
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Unable to reach the MCP server";
    await db
      .update(mcpServer)
      .set({ status: "error", lastError: message, lastTestedAt: new Date(), updatedAt: new Date() })
      .where(eq(mcpServer.id, row.id));
    return { ok: false, server: toServerDto(await getOwnedServer(db, userId, row.id)) };
  }
}

/**
 * Server-side accessor for chat sessions: returns connected servers together
 * with their decrypted token sets. The result must never be serialized to the
 * client.
 */
export async function getConnectedServersWithAuth(env: McpCoreEnv, userId: string) {
  const db = getDb(env.DB);
  const rows = await db.query.mcpServer.findMany({
    where: and(eq(mcpServer.userId, userId), eq(mcpServer.status, "connected")),
  });

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      authType: row.authType as McpServerDto["authType"],
      tokens: row.encryptedAuth ? await decryptJson<TokenSet>(env, row.encryptedAuth) : null,
    })),
  );
}
