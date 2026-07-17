import { ApiError } from "#/lib/api-error";
import { MCP_TOKEN_EXPIRY_SKEW_MS } from "./config.server";
import { readJsonSafely, safeFetch } from "./http.server";
import { assertSafeRedirectTarget } from "./url";

export interface OAuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry time in ms since epoch, if the server provided expires_in. */
  expiresAt?: number;
  scope?: string;
}

/**
 * The complete OAuth material for one MCP server connection. This object is
 * encrypted (AES-256-GCM) before it is stored in `mcp_server.encrypted_auth_data`
 * and is never sent to the browser.
 */
export interface McpAuthData {
  kind: "oauth";
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PkceMaterial {
  state: string;
  verifier: string;
  challenge: string;
}

export async function generatePkceMaterial(): Promise<PkceMaterial> {
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  return { state, verifier, challenge };
}

/**
 * Parses an RFC 9728 `WWW-Authenticate` header, extracting the
 * `resource_metadata` parameter that points at protected-resource metadata.
 */
export function parseWwwAuthenticate(header: string | null): { resourceMetadata?: string } {
  if (!header) return {};
  const match =
    /resource_metadata="([^"]+)"/i.exec(header) ?? /resource_metadata=([^\s,]+)/i.exec(header);
  return match?.[1] ? { resourceMetadata: match[1] } : {};
}

/**
 * RFC 9728 §3.1: the well-known suffix is inserted between the host and the
 * path of the resource URL.
 */
export function deriveProtectedResourceMetadataUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * RFC 8414 §3.1 (+ OIDC Discovery fallback): candidate metadata documents for
 * an authorization server issuer, in priority order.
 */
export function deriveAuthorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname;
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
  ];
}

function assertHttpsEndpoint(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw) {
    throw new ApiError(502, `Authorization server metadata is missing ${field}`);
  }
  return assertSafeRedirectTarget(raw).toString();
}

function parseAuthorizationServerMetadata(
  data: unknown,
  fallbackIssuer: string,
): OAuthServerMetadata {
  if (typeof data !== "object" || data === null) {
    throw new ApiError(502, "Authorization server returned invalid metadata");
  }
  const record = data as Record<string, unknown>;
  return {
    issuer: typeof record.issuer === "string" ? record.issuer : fallbackIssuer,
    authorizationEndpoint: assertHttpsEndpoint(
      record.authorization_endpoint,
      "authorization_endpoint",
    ),
    tokenEndpoint: assertHttpsEndpoint(record.token_endpoint, "token_endpoint"),
    registrationEndpoint:
      typeof record.registration_endpoint === "string" && record.registration_endpoint
        ? assertHttpsEndpoint(record.registration_endpoint, "registration_endpoint")
        : null,
  };
}

/**
 * Discovers the OAuth authorization server protecting an MCP server:
 *
 * 1. RFC 9728 protected-resource metadata (or the URL advertised via the
 *    `WWW-Authenticate: resource_metadata` parameter) to find authorization
 *    servers.
 * 2. RFC 8414 / OIDC discovery on the authorization server.
 * 3. MCP-spec default endpoints (`/authorize`, `/token`, `/register`)
 *    relative to the MCP server origin as a final fallback.
 */
export async function discoverAuthorizationServer(
  serverUrl: string,
  options: { resourceMetadataUrl?: string } = {},
): Promise<OAuthServerMetadata> {
  const server = new URL(serverUrl);
  const candidates: string[] = [server.origin];

  const resourceMetadataUrls = [
    options.resourceMetadataUrl,
    deriveProtectedResourceMetadataUrl(serverUrl),
  ].filter((value, index, all): value is string => !!value && all.indexOf(value) === index);

  for (const metadataUrl of resourceMetadataUrls) {
    let discovered: unknown;
    try {
      const response = await safeFetch(assertSafeRedirectTarget(metadataUrl), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) continue;
      discovered = await readJsonSafely(response);
    } catch (error) {
      if (error instanceof ApiError && error.status === 502) continue;
      throw error;
    }
    if (typeof discovered !== "object" || discovered === null) continue;
    const servers = (discovered as Record<string, unknown>).authorization_servers;
    if (Array.isArray(servers)) {
      for (const entry of servers) {
        if (typeof entry === "string" && entry) {
          candidates.unshift(assertSafeRedirectTarget(entry).toString());
        }
      }
    }
    if (candidates[0] !== server.origin) break;
  }

  for (const issuer of candidates) {
    for (const metadataUrl of deriveAuthorizationServerMetadataUrls(issuer)) {
      try {
        const response = await safeFetch(metadataUrl, { headers: { accept: "application/json" } });
        if (!response.ok) continue;
        const metadata = parseAuthorizationServerMetadata(await readJsonSafely(response), issuer);
        return metadata;
      } catch (error) {
        if (error instanceof ApiError && error.status === 502) continue;
        throw error;
      }
    }
  }

  // MCP-spec fallback: default endpoints relative to the MCP server origin.
  return {
    issuer: server.origin,
    authorizationEndpoint: `${server.origin}/authorize`,
    tokenEndpoint: `${server.origin}/token`,
    registrationEndpoint: `${server.origin}/register`,
  };
}

const CLIENT_NAME = "TanStack Start App";

/**
 * RFC 7591 dynamic client registration. Public client (no client secret)
 * unless the authorization server chooses to issue one.
 */
export async function registerClient(
  metadata: OAuthServerMetadata,
  redirectUri: string,
): Promise<RegisteredClient> {
  if (!metadata.registrationEndpoint) {
    throw new ApiError(400, "This MCP server does not support automatic client registration");
  }

  const response = await safeFetch(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!response.ok) {
    throw new ApiError(502, "Client registration was rejected by the authorization server");
  }
  const data = (await readJsonSafely(response)) as Record<string, unknown> | null;
  if (!data || typeof data.client_id !== "string" || !data.client_id) {
    throw new ApiError(502, "Authorization server returned an invalid client registration");
  }
  return {
    clientId: data.client_id,
    clientSecret: typeof data.client_secret === "string" ? data.client_secret : undefined,
  };
}

export function buildAuthorizationUrl(
  metadata: OAuthServerMetadata,
  params: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    /** RFC 8707 resource indicator: the MCP server URL. */
    resource: string;
  },
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", params.resource);
  return url.toString();
}

function parseTokenResponse(data: unknown): TokenSet {
  if (typeof data !== "object" || data === null) {
    throw new ApiError(502, "Authorization server returned an invalid token response");
  }
  const record = data as Record<string, unknown>;
  if (typeof record.access_token !== "string" || !record.access_token) {
    throw new ApiError(502, "Authorization server did not return an access token");
  }
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : undefined;
  return {
    accessToken: record.access_token,
    refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    scope: typeof record.scope === "string" ? record.scope : undefined,
  };
}

/**
 * Maps token-endpoint error codes to safe, user-facing messages. Provider
 * `error_description` values are deliberately not propagated so unexpected
 * details never reach logs or the client.
 */
function tokenError(status: number, data: unknown): ApiError {
  const code =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>).error : undefined;
  if (code === "invalid_grant") {
    return new ApiError(401, "Authorization expired, reconnect the server", {
      code: "invalid_grant",
    });
  }
  if (status === 400 || status === 401) {
    return new ApiError(502, "The authorization server rejected the request");
  }
  return new ApiError(502, "The authorization server could not complete the request");
}

export async function exchangeAuthorizationCode(
  metadata: OAuthServerMetadata,
  client: RegisteredClient,
  params: { code: string; redirectUri: string; codeVerifier: string; resource: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: client.clientId,
    code_verifier: params.codeVerifier,
    resource: params.resource,
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);

  const response = await safeFetch(metadata.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const data = await readJsonSafely(response);
  if (!response.ok) throw tokenError(response.status, data);
  return parseTokenResponse(data);
}

export async function refreshAccessToken(
  metadata: OAuthServerMetadata,
  client: RegisteredClient,
  params: { refreshToken: string; resource: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: client.clientId,
    resource: params.resource,
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);

  const response = await safeFetch(metadata.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const data = await readJsonSafely(response);
  if (!response.ok) throw tokenError(response.status, data);
  const tokens = parseTokenResponse(data);
  // Some providers rotate refresh tokens; keep the old one when omitted.
  return { ...tokens, refreshToken: tokens.refreshToken ?? params.refreshToken };
}

export function isTokenExpired(auth: Pick<McpAuthData, "expiresAt">): boolean {
  if (!auth.expiresAt) return false;
  return auth.expiresAt - MCP_TOKEN_EXPIRY_SKEW_MS <= Date.now();
}
