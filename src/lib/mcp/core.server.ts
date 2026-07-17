import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "#/db";
import { mcpOAuthState, mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { getBillingSummary, hasEntitlement } from "#/lib/billing/core.server";
import type { BillingEnv } from "#/lib/billing/config.server";

const FREE_MCP_SERVER_LIMIT = 3;
const ACTIVE_MCP_STATUSES = ["connected", "pending_auth", "needs_reconnect", "error"] as const;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
];

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

export interface OAuthMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported?: string[];
}

interface McpTokenData {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  [key: string]: unknown;
}

interface FetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlEncode(bytes: Uint8Array) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function timingSafeStringEqual(left: string, right: string) {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parseEncryptionKey(secret: string) {
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new ApiError(500, "MCP encryption is not configured");
  }

  try {
    const decoded = base64ToBytes(trimmed);
    if (decoded.byteLength >= 32) return decoded.slice(0, 32);
  } catch {
    // Treat non-base64 values as raw secrets below.
  }

  const raw = new TextEncoder().encode(trimmed);
  if (raw.byteLength < 32) {
    throw new ApiError(500, "MCP encryption key must be at least 32 bytes");
  }
  return raw.slice(0, 32);
}

async function importEncryptionKey(secret: string) {
  return crypto.subtle.importKey("raw", parseEncryptionKey(secret), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(value: unknown, secret: string) {
  const key = await importEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  return JSON.stringify({
    v: 1,
    alg: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptJson<T>(encrypted: string, secret: string) {
  const envelope = JSON.parse(encrypted) as { v: number; iv: string; ciphertext: string };
  if (envelope.v !== 1) {
    throw new ApiError(500, "Unsupported MCP encryption envelope");
  }

  const key = await importEncryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  return false;
}

export function normalizeMcpServerUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ApiError(400, "Enter a valid MCP server URL");
  }

  if (parsed.protocol !== "https:") {
    throw new ApiError(400, "MCP server URLs must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(400, "MCP server URLs cannot include credentials");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal" ||
    hostname === "169.254.169.254" ||
    hostname.includes(":") ||
    isPrivateIpv4(hostname)
  ) {
    throw new ApiError(400, "MCP server URL points to a restricted host");
  }

  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  if (parsed.pathname === "") parsed.pathname = "/";
  return parsed.toString();
}

function validateEndpoint(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new ApiError(502, `OAuth discovery did not include ${label}`);
  }
  return normalizeMcpServerUrl(value);
}

function validateOAuthMetadata(value: unknown): OAuthMetadata {
  if (!value || typeof value !== "object") {
    throw new ApiError(502, "OAuth discovery returned an invalid response");
  }

  const body = value as Record<string, unknown>;
  const authorizationEndpoint = validateEndpoint(
    body.authorization_endpoint,
    "an authorization endpoint",
  );
  const tokenEndpoint = validateEndpoint(body.token_endpoint, "a token endpoint");
  const scopes =
    Array.isArray(body.scopes_supported) &&
    body.scopes_supported.every((scope) => typeof scope === "string")
      ? body.scopes_supported
      : undefined;

  return {
    issuer: typeof body.issuer === "string" ? body.issuer : undefined,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    scopes_supported: scopes,
  };
}

async function fetchJsonWithoutRedirects(fetcher: FetchLike, url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("accept", headers.get("accept") ?? "application/json");

  const response = await fetcher(url, {
    ...init,
    redirect: "manual",
    headers,
  });

  if (response.status >= 300 && response.status < 400) {
    throw new ApiError(502, "OAuth discovery redirects are not allowed");
  }
  if (!response.ok) {
    throw new ApiError(502, "OAuth discovery failed", { status: response.status });
  }
  return response.json() as Promise<unknown>;
}

export async function discoverOAuthMetadata(serverUrl: string, fetcher: FetchLike = fetch) {
  const normalizedServerUrl = normalizeMcpServerUrl(serverUrl);
  const server = new URL(normalizedServerUrl);
  const errors: string[] = [];

  for (const path of DISCOVERY_PATHS) {
    const discoveryUrl = new URL(path, server.origin);
    try {
      const metadata = validateOAuthMetadata(
        await fetchJsonWithoutRedirects(fetcher, discoveryUrl.toString()),
      );
      return { serverUrl: normalizedServerUrl, metadata };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Discovery failed");
    }
  }

  throw new ApiError(502, "Unable to discover OAuth metadata for this MCP server", {
    attempts: errors.length,
  });
}

export async function createPkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: base64UrlEncode(new Uint8Array(digest)),
  };
}

export function buildAuthorizationUrl(options: {
  metadata: OAuthMetadata;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string;
}) {
  const authorizationUrl = new URL(options.metadata.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", options.clientId);
  authorizationUrl.searchParams.set("redirect_uri", options.redirectUri);
  authorizationUrl.searchParams.set("state", options.state);
  authorizationUrl.searchParams.set("code_challenge", options.codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (options.scopes) authorizationUrl.searchParams.set("scope", options.scopes);
  return authorizationUrl.toString();
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
  if (!server || !timingSafeStringEqual(server.userId, userId)) {
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

export async function previewMcpDiscovery(serverUrl: string, fetcher?: FetchLike) {
  const discovery = await discoverOAuthMetadata(serverUrl, fetcher);
  return {
    serverUrl: discovery.serverUrl,
    issuer: discovery.metadata.issuer,
    authorizationEndpoint: discovery.metadata.authorization_endpoint,
    tokenEndpoint: discovery.metadata.token_endpoint,
    scopesSupported: discovery.metadata.scopes_supported ?? [],
  };
}

async function getActiveServerCount(env: McpEnv, userId: string) {
  const result = await getDb(env.DB)
    .select({ count: sql<number>`count(*)` })
    .from(mcpServer)
    .where(and(eq(mcpServer.userId, userId), inArray(mcpServer.status, [...ACTIVE_MCP_STATUSES])));
  return Number(result[0]?.count ?? 0);
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
  fetcher?: FetchLike,
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
  } else {
    const unlimited = await hasEntitlement(env, userId, "unlimited_mcp_servers");
    assertCanCreateMcpServer({
      activeServerCount: await getActiveServerCount(env, userId),
      hasUnlimitedServers: unlimited,
    });
  }

  const { serverUrl, metadata } = await discoverOAuthMetadata(input.serverUrl, fetcher);
  const redirectUri = new URL("/api/mcp/auth/callback", input.origin).toString();
  const state = createId("mcpstate");
  const pkce = await createPkcePair();
  const encryptedCodeVerifier = await encryptJson(
    { verifier: pkce.verifier },
    env.MCP_AUTH_ENCRYPTION_KEY,
  );
  const serverId = existingServer?.id ?? createId("mcp");

  await db
    .insert(mcpServer)
    .values({
      id: serverId,
      userId,
      name,
      serverUrl,
      status: "pending_auth",
      oauthIssuer: metadata.issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      scopes: input.scopes?.trim() || null,
      lastError: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [mcpServer.userId, mcpServer.serverUrl],
      set: {
        name,
        status: "pending_auth",
        oauthIssuer: metadata.issuer,
        authorizationEndpoint: metadata.authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
        scopes: input.scopes?.trim() || null,
        lastError: null,
        updatedAt: new Date(),
      },
    });

  const pendingServer = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.userId, userId), eq(mcpServer.serverUrl, serverUrl)),
  });
  if (!pendingServer) {
    throw new ApiError(500, "Unable to prepare MCP server connection");
  }

  await db.insert(mcpOAuthState).values({
    id: state,
    userId,
    serverId: pendingServer.id,
    serverName: name,
    serverUrl,
    redirectUri,
    scopes: input.scopes?.trim() || null,
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
      scopes: input.scopes?.trim(),
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
  fetcher: FetchLike = fetch,
) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: env.MCP_OAUTH_CLIENT_ID ?? "",
    code_verifier: request.codeVerifier,
  });

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };

  if (env.MCP_OAUTH_CLIENT_SECRET) {
    headers.authorization = `Basic ${btoa(
      `${env.MCP_OAUTH_CLIENT_ID ?? ""}:${env.MCP_OAUTH_CLIENT_SECRET}`,
    )}`;
  }

  const response = await fetcher(metadata.token_endpoint, {
    method: "POST",
    redirect: "manual",
    headers,
    body: form,
  });

  if (response.status >= 300 && response.status < 400) {
    throw new ApiError(502, "OAuth token exchange redirects are not allowed");
  }
  if (!response.ok) {
    throw new ApiError(502, "OAuth token exchange failed", { status: response.status });
  }

  const tokenData = (await response.json()) as McpTokenData;
  if (!tokenData.access_token) {
    throw new ApiError(502, "OAuth token response did not include an access token");
  }
  return tokenData;
}

export async function completeMcpAuthorization(
  env: McpEnv,
  userId: string,
  input: {
    state: string;
    code: string;
    redirectUri: string;
  },
  fetcher?: FetchLike,
) {
  const db = getDb(env.DB);
  const pending = await db.query.mcpOAuthState.findFirst({
    where: eq(mcpOAuthState.id, input.state),
  });
  if (!pending || pending.userId !== userId) {
    throw new ApiError(400, "MCP OAuth state is invalid or expired");
  }
  if (pending.expiresAt.getTime() < Date.now()) {
    await db.delete(mcpOAuthState).where(eq(mcpOAuthState.id, pending.id));
    throw new ApiError(400, "MCP OAuth state has expired");
  }
  if (pending.redirectUri !== input.redirectUri) {
    throw new ApiError(400, "MCP OAuth redirect URI mismatch");
  }

  const metadata = JSON.parse(pending.oauthMetadata) as OAuthMetadata;
  const { verifier } = await decryptJson<{ verifier: string }>(
    pending.encryptedCodeVerifier,
    env.MCP_AUTH_ENCRYPTION_KEY,
  );
  const tokenData = await exchangeAuthorizationCode(
    env,
    metadata,
    {
      code: input.code,
      redirectUri: pending.redirectUri,
      codeVerifier: verifier,
    },
    fetcher,
  );
  const encryptedAuthData = await encryptJson(tokenData, env.MCP_AUTH_ENCRYPTION_KEY);

  await db
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
    .where(and(eq(mcpServer.id, pending.serverId ?? ""), eq(mcpServer.userId, userId)));
  await db.delete(mcpOAuthState).where(eq(mcpOAuthState.id, pending.id));
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

  await db
    .update(mcpServer)
    .set({
      name,
      serverUrl,
      status: urlChanged ? "needs_reconnect" : server.status,
      encryptedAuthData: urlChanged ? null : server.encryptedAuthData,
      lastError: urlChanged
        ? "Server URL changed. Reconnect to authenticate this endpoint."
        : server.lastError,
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, input.id), eq(mcpServer.userId, userId)));

  const updated = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, input.id) });
  if (!updated) throw new ApiError(404, "MCP server not found");
  return serializeServer(updated);
}

export async function disconnectMcpServer(env: McpEnv, userId: string, id: string) {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
  assertMcpServerOwner(server, userId);

  await db
    .update(mcpServer)
    .set({
      status: "disconnected",
      encryptedAuthData: null,
      lastTestStatus: null,
      lastError: null,
      connectedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, id), eq(mcpServer.userId, userId)));

  const updated = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
  if (!updated) throw new ApiError(404, "MCP server not found");
  return serializeServer(updated);
}

export async function testMcpServerConnection(
  env: McpEnv,
  userId: string,
  id: string,
  fetcher: FetchLike = fetch,
) {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
  assertMcpServerOwner(server, userId);

  if (!server.encryptedAuthData || server.status !== "connected") {
    throw new ApiError(409, "Reconnect this MCP server before testing it");
  }

  const tokenData = await decryptJson<McpTokenData>(
    server.encryptedAuthData,
    env.MCP_AUTH_ENCRYPTION_KEY,
  );
  if (!tokenData.access_token) {
    throw new ApiError(409, "Reconnect this MCP server before testing it");
  }

  const response = await fetcher(server.serverUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokenData.access_token}`,
    },
  });

  const now = new Date();
  if (response.status >= 300 && response.status < 400) {
    await db
      .update(mcpServer)
      .set({
        lastTestAt: now,
        lastTestStatus: "failed",
        lastError: "The MCP server returned a redirect during testing.",
        updatedAt: now,
      })
      .where(and(eq(mcpServer.id, id), eq(mcpServer.userId, userId)));
    throw new ApiError(502, "MCP server test returned an unsafe redirect");
  }

  const ok = response.ok || response.status === 405 || response.status === 406;
  await db
    .update(mcpServer)
    .set({
      lastTestAt: now,
      lastTestStatus: ok ? "ok" : "failed",
      lastError: ok ? null : `MCP server test failed with HTTP ${response.status}`,
      updatedAt: now,
    })
    .where(and(eq(mcpServer.id, id), eq(mcpServer.userId, userId)));

  if (!ok) {
    throw new ApiError(502, "MCP server test failed", { status: response.status });
  }

  const updated = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
  if (!updated) throw new ApiError(404, "MCP server not found");
  return serializeServer(updated);
}
