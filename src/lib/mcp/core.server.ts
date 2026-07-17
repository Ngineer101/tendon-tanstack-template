import { and, count, desc, eq, ne } from "drizzle-orm";

import { getDb } from "#/db";
import { mcpOAuthState, mcpServerConnection } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { getBillingSummary } from "#/lib/billing/core.server";
import type { BillingEnv } from "#/lib/billing/config.server";

export const FREE_MCP_SERVER_LIMIT = 3;

const SAFE_FETCH_HEADERS = {
  accept: "application/json, application/oauth-authz-server+jwt;q=0.8",
};

const DEFAULT_MCP_SCOPE = "openid profile offline_access";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_DISCOVERY_BYTES = 64_000;

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

interface OAuthServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  authorization_servers?: string[];
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
}

type Fetcher = typeof fetch;

export function isUnlimitedMcpPlan(plan: "free" | "pro_monthly") {
  return plan === "pro_monthly";
}

export function assertCanConnectMcpServer(options: {
  plan: "free" | "pro_monthly";
  activeServerCount: number;
  reconnecting?: boolean;
}) {
  if (options.reconnecting || isUnlimitedMcpPlan(options.plan)) return;

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
  const url = typeof input === "string" ? new URL(input) : input;
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
  if (isUnsafeHostname(hostname) || isPrivateIpLiteral(hostname)) {
    throw new ApiError(400, "This MCP server URL points to a restricted network address.");
  }

  return url;
}

export async function listMcpServers(env: McpEnv, userId: string) {
  const db = getDb(env.DB);
  const [summary, servers, activeCount] = await Promise.all([
    getBillingSummary(env, userId),
    db.query.mcpServerConnection.findMany({
      where: eq(mcpServerConnection.userId, userId),
      orderBy: [desc(mcpServerConnection.createdAt)],
    }),
    getActiveMcpServerCount(env, userId),
  ]);

  const plan = summary.plan === "pro_monthly" ? "pro_monthly" : "free";
  const limit = isUnlimitedMcpPlan(plan) ? null : FREE_MCP_SERVER_LIMIT;
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
  const metadataUrls = new Set<string>();

  const resourceMetadataUrl = await getResourceMetadataFromChallenge(normalizedServerUrl, fetcher);
  if (resourceMetadataUrl) metadataUrls.add(resourceMetadataUrl);

  metadataUrls.add(new URL("/.well-known/oauth-protected-resource", server.origin).toString());
  metadataUrls.add(new URL("/.well-known/oauth-authorization-server", server.origin).toString());
  metadataUrls.add(new URL("/.well-known/openid-configuration", server.origin).toString());

  const authorizationServerUrls = new Set<string>();
  for (const metadataUrl of metadataUrls) {
    const metadata = await tryFetchOAuthMetadata(metadataUrl, fetcher);
    if (!metadata) continue;

    if (metadata.authorization_endpoint && metadata.token_endpoint) {
      return toDiscoveredOAuthServer(metadata);
    }

    for (const authorizationServer of metadata.authorization_servers ?? []) {
      authorizationServerUrls.add(authorizationServer);
    }
  }

  for (const authorizationServer of authorizationServerUrls) {
    const issuer = assertSafeOutboundUrl(authorizationServer);
    const issuerPaths = [
      new URL("/.well-known/oauth-authorization-server", issuer.origin).toString(),
      new URL("/.well-known/openid-configuration", issuer.origin).toString(),
      issuer.toString(),
    ];

    for (const metadataUrl of issuerPaths) {
      const metadata = await tryFetchOAuthMetadata(metadataUrl, fetcher);
      if (metadata?.authorization_endpoint && metadata.token_endpoint) {
        return toDiscoveredOAuthServer(metadata);
      }
    }
  }

  throw new ApiError(422, "OAuth discovery did not find authorization and token endpoints.");
}

export async function beginMcpOAuth(env: McpEnv, input: BeginMcpOAuthInput) {
  const normalizedServerUrl = normalizeMcpServerUrl(input.serverUrl);
  const db = getDb(env.DB);
  const reconnecting = !!input.connectionId;

  if (input.connectionId) {
    const existing = await db.query.mcpServerConnection.findFirst({
      where: eq(mcpServerConnection.id, input.connectionId),
    });
    assertMcpConnectionOwner(existing, input.userId);
  }

  const summary = await getBillingSummary(env, input.userId);
  const activeServerCount = await getActiveMcpServerCount(env, input.userId);
  const plan = summary.plan === "pro_monthly" ? "pro_monthly" : "free";
  assertCanConnectMcpServer({ plan, activeServerCount, reconnecting });

  const discovery = await discoverMcpOAuth(normalizedServerUrl);
  const redirectUri = new URL("/api/mcp/oauth/callback", input.origin).toString();
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
  if (scope) authorizationUrl.searchParams.set("scope", scope);

  await db.insert(mcpOAuthState).values({
    state,
    userId: input.userId,
    connectionId: input.connectionId,
    name: normalizeConnectionName(input.name, normalizedServerUrl),
    serverUrl: normalizedServerUrl,
    authorizationEndpoint: discovery.authorizationEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
    issuer: discovery.issuer,
    clientId: client.client_id,
    clientSecretEncrypted: client.client_secret
      ? await encryptJson(env.MCP_AUTH_ENCRYPTION_KEY, { clientSecret: client.client_secret })
      : null,
    codeVerifier,
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
  const oauthState = await db.query.mcpOAuthState.findFirst({
    where: eq(mcpOAuthState.state, options.state),
  });

  if (!oauthState || oauthState.userId !== options.userId || oauthState.expiresAt < new Date()) {
    throw new ApiError(400, "OAuth session expired. Start the MCP connection again.");
  }

  const clientSecret = oauthState.clientSecretEncrypted
    ? (
        await decryptJson<{ clientSecret: string }>(
          env.MCP_AUTH_ENCRYPTION_KEY,
          oauthState.clientSecretEncrypted,
        )
      ).clientSecret
    : env.MCP_OAUTH_CLIENT_SECRET;

  const tokenResponse = await exchangeOAuthCode({
    tokenEndpoint: oauthState.tokenEndpoint,
    code: options.code,
    clientId: oauthState.clientId,
    clientSecret,
    codeVerifier: oauthState.codeVerifier,
    redirectUri: oauthState.redirectUri,
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
  };
  const encryptedAuthData = await encryptJson(env.MCP_AUTH_ENCRYPTION_KEY, authData);

  if (oauthState.connectionId) {
    const existing = await db.query.mcpServerConnection.findFirst({
      where: eq(mcpServerConnection.id, oauthState.connectionId),
    });
    assertMcpConnectionOwner(existing, options.userId);
    await db
      .update(mcpServerConnection)
      .set({
        name: oauthState.name,
        serverUrl: oauthState.serverUrl,
        status: "connected",
        authDataEncrypted: encryptedAuthData,
        oauthIssuer: oauthState.issuer,
        oauthClientId: oauthState.clientId,
        scopes: authData.scope ?? oauthState.scope,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(mcpServerConnection.id, oauthState.connectionId));
  } else {
    await db
      .insert(mcpServerConnection)
      .values({
        id: createId("mcp"),
        userId: options.userId,
        name: oauthState.name,
        serverUrl: oauthState.serverUrl,
        status: "connected",
        authDataEncrypted: encryptedAuthData,
        oauthIssuer: oauthState.issuer,
        oauthClientId: oauthState.clientId,
        scopes: authData.scope ?? oauthState.scope,
      })
      .onConflictDoUpdate({
        target: [mcpServerConnection.userId, mcpServerConnection.serverUrl],
        set: {
          name: oauthState.name,
          status: "connected",
          authDataEncrypted: encryptedAuthData,
          oauthIssuer: oauthState.issuer,
          oauthClientId: oauthState.clientId,
          scopes: authData.scope ?? oauthState.scope,
          lastError: null,
          updatedAt: new Date(),
        },
      });
  }

  await db.delete(mcpOAuthState).where(eq(mcpOAuthState.state, options.state));
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

  const authData = await decryptJson<StoredAuthData>(
    env.MCP_AUTH_ENCRYPTION_KEY,
    existing.authDataEncrypted,
  );
  const serverUrl = normalizeMcpServerUrl(existing.serverUrl);
  const response = await safeFetch(serverUrl, {
    headers: {
      accept: "application/json",
      authorization: `${authData.tokenType ?? "Bearer"} ${authData.accessToken}`,
    },
    redirect: "manual",
  });

  const ok = response.status >= 200 && response.status < 400;
  const lastError = ok ? null : `Server responded with HTTP ${response.status}`;

  await db
    .update(mcpServerConnection)
    .set({
      status: ok ? "connected" : "error",
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

  const registration = (await response.json()) as Partial<OAuthClientRegistration>;
  if (!registration.client_id) {
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
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    client_id: options.clientId,
    code_verifier: options.codeVerifier,
    redirect_uri: options.redirectUri,
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

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!payload.access_token) {
    throw new ApiError(502, "MCP OAuth token response did not include an access token.");
  }
  return { ...payload, access_token: payload.access_token };
}

async function getResourceMetadataFromChallenge(serverUrl: string, fetcher: Fetcher) {
  const response = await fetcher(serverUrl, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
  });

  if (isRedirect(response.status)) {
    throw new ApiError(400, "MCP discovery redirects are not followed.");
  }

  const header = response.headers.get("www-authenticate");
  if (!header) return undefined;

  const match = header.match(/resource_metadata="([^"]+)"/i);
  if (!match?.[1]) return undefined;
  return assertSafeOutboundUrl(match[1]).toString();
}

async function tryFetchOAuthMetadata(metadataUrl: string, fetcher: Fetcher) {
  try {
    const response = await safeFetch(metadataUrl, { headers: SAFE_FETCH_HEADERS }, fetcher);
    if (!response.ok) return undefined;
    const text = await response.text();
    if (text.length > MAX_DISCOVERY_BYTES) {
      throw new ApiError(502, "MCP OAuth discovery response is too large.");
    }
    return JSON.parse(text) as OAuthServerMetadata;
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) throw error;
    return undefined;
  }
}

function toDiscoveredOAuthServer(metadata: OAuthServerMetadata): DiscoveredOAuthServer {
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new ApiError(422, "OAuth metadata is missing required endpoints.");
  }

  return {
    issuer: metadata.issuer,
    authorizationEndpoint: assertSafeOutboundUrl(metadata.authorization_endpoint).toString(),
    tokenEndpoint: assertSafeOutboundUrl(metadata.token_endpoint).toString(),
    registrationEndpoint: metadata.registration_endpoint
      ? assertSafeOutboundUrl(metadata.registration_endpoint).toString()
      : undefined,
    scopesSupported: metadata.scopes_supported ?? [],
  };
}

async function safeFetch(input: string, init: RequestInit = {}, fetcher: Fetcher = fetch) {
  assertSafeOutboundUrl(input);
  const response = await fetcher(input, { ...init, redirect: "manual" });
  if (isRedirect(response.status)) {
    throw new ApiError(400, "Redirects are not followed for MCP server requests.");
  }
  return response;
}

function isRedirect(status: number) {
  return status >= 300 && status < 400;
}

function sanitizeScope(scope: string | undefined, supportedScopes: string[]) {
  const requested = (scope ?? DEFAULT_MCP_SCOPE)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (!requested.length) return undefined;
  if (!supportedScopes.length) return requested.join(" ");

  const supported = new Set(supportedScopes);
  const allowed = requested.filter((item) => supported.has(item));
  return (allowed.length ? allowed : requested.slice(0, 1)).join(" ");
}

function normalizeConnectionName(name: string | undefined, serverUrl: string) {
  const trimmed = name?.trim();
  if (trimmed) return trimmed.slice(0, 80);
  return new URL(serverUrl).hostname;
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
