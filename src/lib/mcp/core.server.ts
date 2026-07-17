import { and, desc, eq } from "drizzle-orm";

import { getDb } from "#/db";
import { mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { encrypt, decrypt, getEncryptionKey, bytesToBase64 } from "./encryption.server";
import { getBillingSummary, hasEntitlement } from "#/lib/billing/core.server";
import type { BillingEnv } from "#/lib/billing/config.server";

const MAX_FREE_SERVERS = 3;
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^224\./,
  /^(::1|fc00:|fd00:|fe80:)/i,
];

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function validateServerUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(400, "Invalid server URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ApiError(400, "Server URL must use HTTP or HTTPS");
  }

  if (parsed.hostname === "localhost" || parsed.hostname.endsWith(".local")) {
    throw new ApiError(400, "Connections to localhost or local networks are not allowed");
  }

  const isPrivate = PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(parsed.hostname));
  if (isPrivate) {
    throw new ApiError(400, "Connections to private IP ranges are not allowed");
  }

  if (parsed.hostname === "metadata.google.internal") {
    throw new ApiError(400, "Connections to cloud metadata services are not allowed");
  }

  return parsed;
}

function sanitizeUrlForStorage(parsed: URL): string {
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

export interface MCPEnv extends Cloudflare.Env {
  MCP_ENCRYPTION_KEY: string;
  STRIPE_SECRET_KEY: string;
}

export interface MCPCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

async function checkServerLimit(env: MCPEnv, userId: string): Promise<void> {
  const hasUnlimited = await hasEntitlement(env as unknown as BillingEnv, userId, "mcp_unlimited");
  if (hasUnlimited) return;

  const db = getDb(env.DB);
  const count = await db.$count(mcpServer, eq(mcpServer.userId, userId));
  if (count >= MAX_FREE_SERVERS) {
    throw new ApiError(
      403,
      `Free accounts are limited to ${MAX_FREE_SERVERS} MCP servers. Upgrade to Pro for unlimited.`,
      {
        limit: MAX_FREE_SERVERS,
        current: count,
      },
    );
  }
}

export async function listMCPSevers(env: MCPEnv, userId: string) {
  const db = getDb(env.DB);
  const servers = await db.query.mcpServer.findMany({
    where: eq(mcpServer.userId, userId),
    orderBy: [desc(mcpServer.createdAt)],
  });

  return servers.map((s) => ({
    id: s.id,
    name: s.name,
    serverUrl: s.serverUrl,
    status: s.status,
    hasCredentials: !!s.encryptedCredentials,
    oauthProvider: s.oauthProvider,
    lastTestedAt: s.lastTestedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}

export async function getMCPServer(env: MCPEnv, userId: string, serverId: string) {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });

  if (!server) {
    throw new ApiError(404, "MCP server not found");
  }

  return {
    id: server.id,
    name: server.name,
    serverUrl: server.serverUrl,
    status: server.status,
    hasCredentials: !!server.encryptedCredentials,
    oauthProvider: server.oauthProvider,
    lastTestedAt: server.lastTestedAt,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

export async function createMCPServer(
  env: MCPEnv,
  userId: string,
  data: { name: string; serverUrl: string },
) {
  await checkServerLimit(env, userId);

  const parsed = validateServerUrl(data.serverUrl);
  const sanitizedUrl = sanitizeUrlForStorage(parsed);

  if (!data.name.trim()) {
    throw new ApiError(400, "Server name is required");
  }

  const db = getDb(env.DB);
  const id = createId("mcp");
  const now = new Date();

  await db.insert(mcpServer).values({
    id,
    userId,
    name: data.name.trim(),
    serverUrl: sanitizedUrl,
    status: "disconnected",
    createdAt: now,
    updatedAt: now,
  });

  return getMCPServer(env, userId, id);
}

export async function updateMCPServer(
  env: MCPEnv,
  userId: string,
  serverId: string,
  data: { name?: string; serverUrl?: string },
) {
  await getMCPServer(env, userId, serverId);
  const db = getDb(env.DB);

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (data.name !== undefined) {
    if (!data.name.trim()) {
      throw new ApiError(400, "Server name is required");
    }
    updates.name = data.name.trim();
  }

  if (data.serverUrl !== undefined) {
    const parsed = validateServerUrl(data.serverUrl);
    updates.serverUrl = sanitizeUrlForStorage(parsed);
    updates.status = "disconnected";
    updates.encryptedCredentials = null;
    updates.oauthProvider = null;
  }

  await db
    .update(mcpServer)
    .set(updates)
    .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));

  return getMCPServer(env, userId, serverId);
}

export async function disconnectMCPServer(env: MCPEnv, userId: string, serverId: string) {
  await getMCPServer(env, userId, serverId);
  const db = getDb(env.DB);

  await db
    .update(mcpServer)
    .set({
      status: "disconnected",
      encryptedCredentials: null,
      oauthProvider: null,
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));

  return getMCPServer(env, userId, serverId);
}

export async function deleteMCPServer(env: MCPEnv, userId: string, serverId: string) {
  await getMCPServer(env, userId, serverId);
  const db = getDb(env.DB);

  await db.delete(mcpServer).where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));

  return { deleted: true };
}

export async function storeCredentials(
  env: MCPEnv,
  userId: string,
  serverId: string,
  credentials: MCPCredentials,
) {
  await getMCPServer(env, userId, serverId);
  const db = getDb(env.DB);
  const key = getEncryptionKey(env);

  const encrypted = await encrypt(JSON.stringify(credentials), key);

  await db
    .update(mcpServer)
    .set({
      encryptedCredentials: encrypted,
      status: "connected",
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));

  return getMCPServer(env, userId, serverId);
}

export async function getDecryptedCredentials(
  env: MCPEnv,
  userId: string,
  serverId: string,
): Promise<MCPCredentials | null> {
  const db = getDb(env.DB);
  const server = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });

  if (!server || !server.encryptedCredentials) return null;

  const key = getEncryptionKey(env);
  const decrypted = await decrypt(server.encryptedCredentials, key);
  return JSON.parse(decrypted) as MCPCredentials;
}

export async function testConnection(env: MCPEnv, userId: string, serverId: string) {
  await getMCPServer(env, userId, serverId);
  const db = getDb(env.DB);

  await db
    .update(mcpServer)
    .set({ status: "testing", updatedAt: new Date() })
    .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));

  try {
    const server = await getMCPServer(env, userId, serverId);
    const response = await fetch(server.serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 1,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok && response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }

    await db
      .update(mcpServer)
      .set({ status: "connected", lastTestedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));

    return { success: true };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Connection failed";

    await db
      .update(mcpServer)
      .set({ status: "error", lastTestedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));

    return { success: false, error: message };
  }
}

export async function discoverOAuth(serverUrl: string) {
  validateServerUrl(serverUrl);

  const metadataUrl = `${serverUrl.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;

  let response: Response;
  try {
    response = await fetch(metadataUrl, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new ApiError(400, "Unable to reach MCP server for OAuth discovery");
  }

  if (!response.ok) {
    throw new ApiError(400, "MCP server does not support OAuth (no metadata found)");
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Invalid OAuth metadata response from MCP server");
  }

  const authorizationEndpoint =
    typeof metadata["authorization_endpoint"] === "string"
      ? metadata["authorization_endpoint"]
      : undefined;
  const tokenEndpoint =
    typeof metadata["token_endpoint"] === "string" ? metadata["token_endpoint"] : undefined;

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new ApiError(400, "MCP server OAuth metadata is missing required endpoints");
  }

  return {
    authorizationEndpoint,
    tokenEndpoint,
    scopesSupported: Array.isArray(metadata["scopes_supported"])
      ? (metadata["scopes_supported"] as string[])
      : [],
  };
}

export async function initiateOAuth(
  env: MCPEnv,
  userId: string,
  serverId: string,
  callbackOrigin: string,
) {
  const server = await getMCPServer(env, userId, serverId);
  const oauthConfig = await discoverOAuth(server.serverUrl);

  const codeVerifier = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
  const codeChallenge = bytesToBase64(new Uint8Array(digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const state = crypto.randomUUID();

  const key = getEncryptionKey(env);
  const stateData = await encrypt(JSON.stringify({ serverId, codeVerifier, state, userId }), key);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: callbackOrigin,
    redirect_uri: `${callbackOrigin}/api/mcp/oauth/callback`,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: `${state}.${stateData}`,
  });

  if (oauthConfig.scopesSupported.length > 0) {
    params.set("scope", oauthConfig.scopesSupported.join(" "));
  }

  const authUrl = `${oauthConfig.authorizationEndpoint}?${params.toString()}`;

  return {
    authorizationUrl: authUrl,
    tokenEndpoint: oauthConfig.tokenEndpoint,
  };
}

export async function completeOAuth(
  env: MCPEnv,
  code: string,
  stateParam: string,
  requestOrigin: string,
) {
  const [state, stateData] = stateParam.split(".");
  if (!state || !stateData) {
    throw new ApiError(400, "Invalid OAuth state parameter");
  }

  const key = getEncryptionKey(env);
  let statePayload: { serverId: string; codeVerifier: string; state: string; userId: string };
  try {
    statePayload = JSON.parse(await decrypt(stateData, key)) as typeof statePayload;
  } catch {
    throw new ApiError(400, "Invalid or expired OAuth state");
  }

  if (statePayload.state !== state) {
    throw new ApiError(400, "OAuth state mismatch");
  }

  const server = await getMCPServer(env, statePayload.userId, statePayload.serverId);
  const oauthConfig = await discoverOAuth(server.serverUrl);

  const callbackUrl = `${requestOrigin}/api/mcp/oauth/callback`;

  const tokenResponse = await fetch(oauthConfig.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: statePayload.codeVerifier,
      redirect_uri: callbackUrl,
      client_id: requestOrigin,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text().catch(() => "");
    throw new ApiError(400, `Token exchange failed: ${errorBody || tokenResponse.statusText}`);
  }

  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!tokens.access_token) {
    throw new ApiError(400, "MCP server did not return an access token");
  }

  const credentials: MCPCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    scopes: tokens.scope ? tokens.scope.split(" ") : undefined,
  };

  await storeCredentials(env, statePayload.userId, statePayload.serverId, credentials);

  return getMCPServer(env, statePayload.userId, statePayload.serverId);
}

export async function getBillingLimitInfo(env: MCPEnv, userId: string) {
  const db = getDb(env.DB);
  const summary = await getBillingSummary(env as unknown as BillingEnv, userId);
  const count = await db.$count(mcpServer, eq(mcpServer.userId, userId));
  const isPro = summary.plan === "pro_monthly";

  return {
    current: count,
    limit: isPro ? null : MAX_FREE_SERVERS,
    isPro,
  };
}
