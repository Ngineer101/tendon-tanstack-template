import { and, count, eq } from "drizzle-orm";

import { getDb } from "#/db";
import { mcpServer } from "#/db/schema";
import { ApiError } from "#/lib/api-error";
import { hasEntitlement } from "#/lib/billing/core.server";
import {
  MCP_LIMITS,
  MCP_ENTITLEMENT,
  MCP_STATUS,
  OAUTH_FLOW_TTL_MS,
  MCP_RPC,
  type McpStatus,
} from "./config";
import type { McpEnv } from "./config.server";
import { cipher } from "./crypto.server";
import { validateOutboundUrl, assertSameOriginRedirect, type NormalizedUrl } from "./url.server";

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export interface SafeMcpServer {
  id: string;
  name: string;
  url: string;
  status: McpStatus;
  metadata: OauthMetadata | null;
  serverInfo: ServerInfo | null;
  lastError: string | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OauthMetadata {
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  grantTypesSupported?: string[];
  responseTypesSupported?: string[];
}

interface ServerInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
}

interface AuthPayload {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  expiresAt?: number;
  scope?: string;
}

interface PendingPayload {
  codeVerifier: string;
  state: string;
  redirectUri: string;
  createdAt: number;
}

function strip(row: typeof mcpServer.$inferSelect): SafeMcpServer {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    status: row.status as McpStatus,
    metadata: row.metadata ? (JSON.parse(row.metadata) as OauthMetadata) : null,
    serverInfo: row.serverInfo ? (JSON.parse(row.serverInfo) as ServerInfo) : null,
    lastError: row.lastError,
    lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// --- Entitlement / limit enforcement -------------------------------------

export async function getMcpLimit(
  env: McpEnv,
  userId: string,
): Promise<{ limit: number; pro: boolean }> {
  const pro = await hasEntitlement(env, userId, MCP_ENTITLEMENT);
  return { limit: pro ? Number.POSITIVE_INFINITY : MCP_LIMITS.freeServerLimit, pro };
}

export async function assertWithinMcpLimit(env: McpEnv, userId: string): Promise<void> {
  const { limit, pro } = await getMcpLimit(env, userId);
  if (pro) return;
  const db = getDb(env.DB);
  const [row] = await db.select({ n: count() }).from(mcpServer).where(eq(mcpServer.userId, userId));
  if ((row?.n ?? 0) >= limit) {
    throw new ApiError(
      402,
      `Free plans can connect at most ${limit} MCP servers. Upgrade to Pro for unlimited servers.`,
      {
        limit,
        plan: "free",
      },
    );
  }
}

// --- OAuth discovery ------------------------------------------------------

export async function discoverOauthMetadata(
  url: NormalizedUrl,
  fetchImpl: typeof fetch = fetch,
): Promise<OauthMetadata> {
  // Per MCP (RFC 9728-ish), clients fetch the server's
  // `/.well-known/oauth-authorization-server` metadata, optionally scoped to
  // the resource. We try the resource-scoped variant first then the bare one.
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server?resource=${encodeURIComponent(url.url)}`,
    `${url.origin}/.well-known/oauth-authorization-server`,
  ];

  let lastStatus = 0;
  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
      });
      lastStatus = response.status;
      if (response.status === 200) {
        const json = (await response.json()) as Record<string, unknown>;
        if (typeof json.authorization_endpoint !== "string") {
          continue;
        }
        const scopesSupported = Array.isArray(json.scopes_supported)
          ? (json.scopes_supported as unknown[]).filter((s): s is string => typeof s === "string")
          : undefined;
        const grantTypesSupported = Array.isArray(json.grant_types_supported)
          ? (json.grant_types_supported as unknown[]).filter(
              (s): s is string => typeof s === "string",
            )
          : undefined;
        const responseTypesSupported = Array.isArray(json.response_types_supported)
          ? (json.response_types_supported as unknown[]).filter(
              (s): s is string => typeof s === "string",
            )
          : undefined;
        const tokenEndpoint =
          typeof json.token_endpoint === "string" ? json.token_endpoint : undefined;
        const registrationEndpoint =
          typeof json.registration_endpoint === "string" ? json.registration_endpoint : undefined;
        return {
          authorizationEndpoint: json.authorization_endpoint,
          tokenEndpoint,
          registrationEndpoint,
          scopesSupported,
          grantTypesSupported,
          responseTypesSupported,
        };
      }
    } catch {
      // Try the next candidate.
    }
  }

  // No metadata published. Return null sentinel via throw so callers can
  // surface a clear message rather than silently continuing.
  if (lastStatus === 404) {
    throw new ApiError(
      422,
      "This server did not publish OAuth metadata. Confirm the URL or contact the MCP server operator.",
    );
  }
  throw new ApiError(502, "Unable to fetch OAuth metadata from this server");
}

// --- CRUD -----------------------------------------------------------------

export interface CreateMcpServerInput {
  name: string;
  url: string;
}

export async function listMcpServers(env: McpEnv, userId: string): Promise<SafeMcpServer[]> {
  const db = getDb(env.DB);
  const rows = await db.query.mcpServer.findMany({ where: eq(mcpServer.userId, userId) });
  return rows.map(strip).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getMcpServerForUser(env: McpEnv, userId: string, serverId: string) {
  const db = getDb(env.DB);
  const row = await db.query.mcpServer.findFirst({
    where: and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)),
  });
  if (!row) throw new ApiError(404, "MCP server not found");
  return row;
}

export async function getSafeMcpServer(
  env: McpEnv,
  userId: string,
  serverId: string,
): Promise<SafeMcpServer> {
  return strip(await getMcpServerForUser(env, userId, serverId));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return base64UrlEncode(bytes).slice(0, length);
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

// --- Connect / authorize flow --------------------------------------------

export interface DiscoverAndCreateResult {
  server: SafeMcpServer;
  // Whether OAuth metadata was found. If false, the server may still be
  // usable without authentication (public MCP servers).
  requiresAuth: boolean;
}

export async function createMcpServerConnection(
  env: McpEnv,
  userId: string,
  input: CreateMcpServerInput,
): Promise<DiscoverAndCreateResult> {
  if (typeof input.name !== "string" || input.name.trim() === "" || input.name.length > 80) {
    throw new ApiError(400, "Provide a name between 1 and 80 characters");
  }
  const normalized = validateOutboundUrl(input.url, {
    allowInsecureHttp: env.MCP_ALLOW_INSECURE_HTTP === "true",
  });

  await assertWithinMcpLimit(env, userId);

  let metadata: OauthMetadata | null = null;
  let discoveryError: string | null = null;
  try {
    metadata = await discoverOauthMetadata(normalized);
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) {
      // Server does not publish OAuth metadata. Allow the connection in
      // `pending` state; user can still test it.
      discoveryError = error.message;
    } else if (error instanceof ApiError && error.status === 502) {
      discoveryError = error.message;
      // 502 means we couldn't reach the server at all — fail the create
      // outright so the user gets immediate feedback rather than a phantom row.
      throw error;
    } else {
      throw error;
    }
  }

  const id = createId("mcp");
  const db = getDb(env.DB);
  await db.insert(mcpServer).values({
    id,
    userId,
    name: input.name.trim(),
    url: normalized.url,
    status: MCP_STATUS.pending,
    metadata: metadata ? JSON.stringify(metadata) : null,
    lastError: discoveryError,
  });

  const row = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, id) });
  if (!row) throw new ApiError(500, "Unable to create MCP server");
  return { server: strip(row), requiresAuth: Boolean(metadata?.authorizationEndpoint) };
}

// Build the authorization URL the browser should navigate to. Stores the
// PKCE verifier + state encrypted on the server row so the callback can
// complete the exchange without server-side sessions.
export async function beginAuthorization(
  env: McpEnv,
  userId: string,
  serverId: string,
  appOrigin: string,
): Promise<{ authorizationUrl: string }> {
  const row = await getMcpServerForUser(env, userId, serverId);
  if (!row.metadata) {
    throw new ApiError(409, "This server has no OAuth metadata; connect it directly instead.");
  }
  const metadata = JSON.parse(row.metadata) as OauthMetadata;
  if (!metadata.authorizationEndpoint) {
    throw new ApiError(409, "This server did not advertise an authorization endpoint.");
  }

  // The OAuth `redirect_uri` is *this app's* callback, not the MCP server's
  // origin. It is derived solely from the trusted request origin (enforced to
  // match by the same-origin API handler) plus a fixed path, so it cannot be
  // redirected to an attacker-controlled host. We therefore must NOT apply the
  // same-origin check to it; that check is reserved for the authorization and
  // token endpoints exposed by the MCP server itself (see below).
  const redirectUri = `${appOrigin.replace(/\/$/, "")}/api/mcp/oauth/callback`;

  const codeVerifier = randomString(64);
  const state = `${serverId}:${randomString(24)}`;
  const challenge = base64UrlEncode(await sha256(codeVerifier));

  const authorUrlThirdParty = new URL(metadata.authorizationEndpoint);
  // Disallow the auth endpoint from living on a different origin than the
  // server (would let a server redirect us to an attacker, or vice versa).
  if (authorUrlThirdParty.protocol !== "https:" && env.MCP_ALLOW_INSECURE_HTTP !== "true") {
    throw new ApiError(400, "Authorization endpoint must use https");
  }
  if (authorUrlThirdParty.username || authorUrlThirdParty.password) {
    throw new ApiError(400, "Authorization endpoint must not contain credentials");
  }
  authorUrlThirdParty.searchParams.set("response_type", "code");
  authorUrlThirdParty.searchParams.set("client_id", appOrigin.replace(/^https?:\/\//, ""));
  authorUrlThirdParty.searchParams.set("redirect_uri", redirectUri);
  authorUrlThirdParty.searchParams.set("state", state);
  authorUrlThirdParty.searchParams.set("code_challenge", challenge);
  authorUrlThirdParty.searchParams.set(
    "code_challenge_method",
    metadata.grantTypesSupported?.includes("authorization_code") === false ? "plain" : "S256",
  );
  if (metadata.scopesSupported?.length) {
    authorUrlThirdParty.searchParams.set("scope", metadata.scopesSupported.join(" "));
  }

  const pending: PendingPayload = {
    codeVerifier,
    state,
    redirectUri,
    createdAt: Date.now(),
  };
  const encryptedPending = await cipher.encrypt(pending, getEncryptionKeySafe(env));

  const db = getDb(env.DB);
  await db
    .update(mcpServer)
    .set({ oauthPending: encryptedPending, lastError: null, updatedAt: new Date() })
    .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));

  return { authorizationUrl: authorUrlThirdParty.toString() };
}

export interface CallbackParams {
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
}

export async function completeAuthorization(
  env: McpEnv,
  params: CallbackParams,
  fetchImpl: typeof fetch = fetch,
): Promise<SafeMcpServer> {
  if (params.error) {
    throw new ApiError(400, params.errorDescription || `Authorization denied: ${params.error}`);
  }
  if (!params.code || !params.state) {
    throw new ApiError(400, "Missing authorization code or state");
  }
  const [serverId] = params.state.split(":");
  if (!serverId) throw new ApiError(400, "Invalid authorization state");

  const key = getEncryptionKeySafe(env);
  const db = getDb(env.DB);
  const row = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, serverId) });
  if (!row) throw new ApiError(400, "Invalid authorization state");
  if (!row.oauthPending) throw new ApiError(400, "No pending authorization for this server");
  if (!row.metadata) throw new ApiError(400, "Server metadata missing");

  let pending: PendingPayload;
  try {
    pending = await cipher.decrypt<PendingPayload>(row.oauthPending, key);
  } catch {
    throw new ApiError(400, "Authorization state could not be verified");
  }
  // Constant-time-ish compare of state.
  if (!safeEqual(pending.state, params.state)) {
    throw new ApiError(400, "Authorization state mismatch");
  }
  if (Date.now() - pending.createdAt > OAUTH_FLOW_TTL_MS) {
    throw new ApiError(400, "Authorization flow expired. Please reconnect.");
  }

  const metadata = JSON.parse(row.metadata) as OauthMetadata;
  if (!metadata.tokenEndpoint) {
    throw new ApiError(400, "Server metadata is missing a token endpoint");
  }
  // Confirm the token endpoint lives on the server origin too.
  assertSameOriginRedirect(new URL(row.url).origin, metadata.tokenEndpoint);

  const tokenResponse = await fetchImpl(metadata.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    redirect: "error",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: pending.redirectUri,
      client_id: pending.redirectUri.replace(/^https?:\/\//, ""),
      code_verifier: pending.codeVerifier,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await tokenResponse.json());
    } catch {
      // ignore body parse errors
    }
    // Never include the raw body in user-facing errors verbatim if it might
    // echo the verifier. We surface a generic message and a status code only.
    void detail;
    throw new ApiError(502, `Token exchange failed (HTTP ${tokenResponse.status})`);
  }

  let tokens: AuthPayload;
  try {
    const body = (await tokenResponse.json()) as Record<string, unknown>;
    if (typeof body.access_token !== "string") {
      throw new ApiError(502, "Token response did not include an access token");
    }
    tokens = {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
      tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : undefined,
      expiresAt:
        typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
      scope: typeof body.scope === "string" ? body.scope : undefined,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "Unable to parse token response");
  }

  const key2 = getEncryptionKeySafe(env);
  const encryptedAuth = await cipher.encrypt(tokens, key2);
  await db
    .update(mcpServer)
    .set({
      encryptedAuth,
      oauthPending: null,
      status: MCP_STATUS.connected,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(mcpServer.id, serverId));

  const updated = await db.query.mcpServer.findFirst({ where: eq(mcpServer.id, serverId) });
  if (!updated) throw new ApiError(500, "Unable to load updated server");
  return strip(updated);
}

// --- Test / probe ---------------------------------------------------------

export async function testMcpServer(
  env: McpEnv,
  userId: string,
  serverId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; serverInfo: ServerInfo } | { ok: false; error: string }> {
  const row = await getMcpServerForUser(env, userId, serverId);
  const key = getEncryptionKeySafe(env);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  if (row.encryptedAuth) {
    try {
      const auth = await cipher.decrypt<AuthPayload>(row.encryptedAuth, key);
      headers.authorization = `${auth.tokenType ?? "Bearer"} ${auth.accessToken}`;
    } catch {
      return {
        ok: false,
        error: "Stored credentials could not be decrypted. Reconnect the server.",
      };
    }
  }

  const response = await fetchImpl(row.url, {
    method: "POST",
    headers,
    redirect: "error",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_RPC.protocolVersion,
        capabilities: {},
        clientInfo: { name: "tendon-tanstack-template", version: "0.0.0" },
      },
    }),
  });

  if (!response.ok) {
    return { ok: false, error: `Server responded with HTTP ${response.status}` };
  }

  let body: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      const firstData = text.split("\n").find((line) => line.startsWith("data:"));
      body = firstData ? JSON.parse(firstData.slice(5).trim()) : null;
    } else {
      body = await response.json();
    }
  } catch {
    return { ok: false, error: "Server returned a non-JSON response" };
  }

  const result = body as { result?: { serverInfo?: ServerInfo; protocolVersion?: string } };
  if (!result?.result) {
    return { ok: false, error: "Server did not return an initialize result" };
  }

  const serverInfo: ServerInfo = {
    name: result.result.serverInfo?.name,
    version: result.result.serverInfo?.version,
    protocolVersion: result.result.protocolVersion,
    capabilities: result.result.serverInfo?.capabilities,
  };

  const db = getDb(env.DB);
  await db
    .update(mcpServer)
    .set({
      lastTestedAt: new Date(),
      serverInfo: JSON.stringify(serverInfo),
      status: MCP_STATUS.connected,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));

  return { ok: true, serverInfo };
}

// --- Edit / disconnect ----------------------------------------------------

export interface EditMcpServerInput {
  name?: string;
  url?: string;
}

export async function editMcpServer(
  env: McpEnv,
  userId: string,
  serverId: string,
  input: EditMcpServerInput,
): Promise<SafeMcpServer> {
  const row = await getMcpServerForUser(env, userId, serverId);
  const updates: Partial<typeof mcpServer.$inferInsert> = { updatedAt: new Date() };

  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.trim() === "" || input.name.length > 80) {
      throw new ApiError(400, "Provide a name between 1 and 80 characters");
    }
    updates.name = input.name.trim();
  }

  if (input.url !== undefined && input.url !== row.url) {
    const normalized = validateOutboundUrl(input.url, {
      allowInsecureHttp: env.MCP_ALLOW_INSECURE_HTTP === "true",
    });
    updates.url = normalized.url;
    // URL change invalidates stored auth — force the user to re-authenticate.
    updates.encryptedAuth = null;
    updates.oauthPending = null;
    updates.status = MCP_STATUS.pending;
    updates.lastError = null;
    let metadata: OauthMetadata | null = null;
    try {
      metadata = await discoverOauthMetadata(normalized);
      updates.metadata = metadata ? JSON.stringify(metadata) : null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        updates.metadata = null;
        updates.lastError = error.message;
      } else if (error instanceof ApiError && error.status === 502) {
        updates.metadata = null;
        updates.lastError = error.message;
      } else {
        throw error;
      }
    }
  }

  const db = getDb(env.DB);
  await db
    .update(mcpServer)
    .set(updates)
    .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));
  return getSafeMcpServer(env, userId, serverId);
}

export async function deleteMcpServer(
  env: McpEnv,
  userId: string,
  serverId: string,
): Promise<void> {
  const db = getDb(env.DB);
  const result = await db
    .delete(mcpServer)
    .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));
  if (result.meta.changes === 0) throw new ApiError(404, "McpServer not found");
}

// Revoke stored credentials for a server without deleting the row. The server
// remains visible in the grid with a `disconnected` status and can be
// reconnected later. This also clears any in-flight OAuth pending state so a
// stale verifier cannot be replayed after a deliberate disconnect.
export async function disconnectMcpServer(
  env: McpEnv,
  userId: string,
  serverId: string,
): Promise<SafeMcpServer> {
  await getMcpServerForUser(env, userId, serverId);
  const db = getDb(env.DB);
  await db
    .update(mcpServer)
    .set({
      encryptedAuth: null,
      oauthPending: null,
      status: MCP_STATUS.disconnected,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(mcpServer.id, serverId), eq(mcpServer.userId, userId)));
  return getSafeMcpServer(env, userId, serverId);
}

// --- Helpers --------------------------------------------------------------

function getEncryptionKeySafe(env: McpEnv): ArrayBuffer {
  // Re-validated here so a missing/invalid secret surfaces as a 500 instead
  // of crashing the request unhandled.
  const raw = env.MCP_ENCRYPTION_KEY;
  if (!raw) throw new ApiError(500, "Encryption is not configured");
  const standard = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength !== 32) throw new ApiError(500, "Encryption key is malformed");
  return bytes.buffer;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
