import { ApiError } from "#/lib/api-error";
import { assertSafeHttpUrl, safeFetch } from "./url-security.server";

// OAuth 2.1 support for MCP servers, following the MCP authorization spec:
// protected-resource metadata (RFC 9728), authorization-server metadata
// (RFC 8414 / OIDC discovery), dynamic client registration (RFC 7591),
// PKCE (RFC 7636), and resource indicators (RFC 8707).

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OAuthDiscovery {
  resource: string;
  scopes: string[] | null;
  authServer: AuthorizationServerMetadata;
}

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

const DISCOVERY_TIMEOUT_MS = 10_000;

export function parseWwwAuthenticate(header: string | null | undefined) {
  const match = header?.match(/resource_metadata="([^"]+)"/);
  return { resourceMetadataUrl: match?.[1] };
}

async function fetchJsonDocument(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await safeFetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function wellKnownCandidates(base: URL, suffix: string) {
  const path = base.pathname.replace(/\/$/, "");
  const candidates = [`${base.origin}/.well-known/${suffix}`];
  if (path) {
    candidates.unshift(`${base.origin}/.well-known/${suffix}${path}`);
  }
  return candidates;
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

function validateAuthServerMetadata(document: Record<string, unknown>) {
  const { issuer, authorization_endpoint, token_endpoint } = document;
  if (
    typeof issuer !== "string" ||
    typeof authorization_endpoint !== "string" ||
    typeof token_endpoint !== "string"
  ) {
    return null;
  }
  // Every endpoint we will contact or redirect the user to must itself pass
  // the SSRF checks.
  assertSafeHttpUrl(authorization_endpoint, "Authorization endpoint");
  assertSafeHttpUrl(token_endpoint, "Token endpoint");
  const metadata: AuthorizationServerMetadata = {
    issuer,
    authorization_endpoint,
    token_endpoint,
  };
  if (typeof document.registration_endpoint === "string") {
    assertSafeHttpUrl(document.registration_endpoint, "Registration endpoint");
    metadata.registration_endpoint = document.registration_endpoint;
  }
  if (typeof document.revocation_endpoint === "string") {
    assertSafeHttpUrl(document.revocation_endpoint, "Revocation endpoint");
    metadata.revocation_endpoint = document.revocation_endpoint;
  }
  metadata.scopes_supported = asStringArray(document.scopes_supported) ?? undefined;
  metadata.code_challenge_methods_supported =
    asStringArray(document.code_challenge_methods_supported) ?? undefined;
  return metadata;
}

export async function discoverOAuth(
  serverUrl: string,
  wwwAuthenticate?: string | null,
  fetchDocument: typeof fetchJsonDocument = fetchJsonDocument,
): Promise<OAuthDiscovery> {
  const resourceUrl = assertSafeHttpUrl(serverUrl, "Server URL");

  // 1. Protected-resource metadata: from the WWW-Authenticate hint if the
  //    server provided one, otherwise from its well-known locations.
  const { resourceMetadataUrl } = parseWwwAuthenticate(wwwAuthenticate);
  const resourceCandidates = resourceMetadataUrl
    ? [assertSafeHttpUrl(resourceMetadataUrl, "Resource metadata URL").toString()]
    : wellKnownCandidates(resourceUrl, "oauth-protected-resource");

  let scopes: string[] | null = null;
  let authServerIssuer: string | null = null;
  for (const candidate of resourceCandidates) {
    const document = await fetchDocument(candidate);
    if (!document) continue;
    const authorizationServers = asStringArray(document.authorization_servers);
    if (authorizationServers?.[0]) {
      authServerIssuer = authorizationServers[0];
      scopes = asStringArray(document.scopes_supported);
      break;
    }
  }

  // 2. Authorization-server metadata. When no protected-resource metadata is
  //    published, fall back to treating the MCP server origin as the issuer
  //    (pre-2025-06-18 MCP spec behavior).
  const issuerUrl = assertSafeHttpUrl(authServerIssuer ?? resourceUrl.origin, "Issuer URL");
  const metadataCandidates = [
    ...wellKnownCandidates(issuerUrl, "oauth-authorization-server"),
    ...wellKnownCandidates(issuerUrl, "openid-configuration"),
  ];
  for (const candidate of metadataCandidates) {
    const document = await fetchDocument(candidate);
    if (!document) continue;
    const metadata = validateAuthServerMetadata(document);
    if (metadata) {
      if (!scopes) {
        scopes = asStringArray(document.scopes_supported);
      }
      return { resource: resourceUrl.toString(), scopes, authServer: metadata };
    }
  }

  throw new ApiError(
    422,
    "This server requires authentication but does not publish OAuth metadata we can use",
    { code: "oauth_discovery_failed" },
  );
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function computeCodeChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export function generateStateToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function buildAuthorizationUrl(
  metadata: AuthorizationServerMetadata,
  options: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    resource: string;
    scope?: string;
  },
) {
  if (
    metadata.code_challenge_methods_supported &&
    !metadata.code_challenge_methods_supported.includes("S256")
  ) {
    throw new ApiError(422, "The authorization server does not support PKCE (S256)", {
      code: "oauth_pkce_unsupported",
    });
  }
  const url = assertSafeHttpUrl(metadata.authorization_endpoint, "Authorization endpoint");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", options.resource);
  if (options.scope) {
    url.searchParams.set("scope", options.scope);
  }
  return url.toString();
}

export async function registerOAuthClient(
  metadata: AuthorizationServerMetadata,
  options: { redirectUri: string; clientName: string },
): Promise<OAuthClient> {
  if (!metadata.registration_endpoint) {
    throw new ApiError(
      422,
      "This server requires OAuth but its authorization server does not support automatic client registration",
      { code: "oauth_registration_unsupported" },
    );
  }
  const response = await safeFetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: options.clientName,
      redirect_uris: [options.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof body?.client_id !== "string") {
    throw new ApiError(502, "The authorization server rejected client registration", {
      code: "oauth_registration_failed",
    });
  }
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === "string" ? body.client_secret : undefined,
  };
}

async function requestToken(
  metadata: AuthorizationServerMetadata,
  params: Record<string, string>,
  client: OAuthClient,
): Promise<TokenResponse> {
  const body = new URLSearchParams({ ...params, client_id: client.clientId });
  if (client.clientSecret) {
    body.set("client_secret", client.clientSecret);
  }
  const response = await safeFetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof payload?.access_token !== "string") {
    // Only surface the standard OAuth error code — never the raw response,
    // which could contain sensitive material.
    const code = typeof payload?.error === "string" ? payload.error : "token_request_failed";
    throw new ApiError(502, `The authorization server rejected the token request (${code})`, {
      code: "oauth_token_request_failed",
    });
  }
  return {
    access_token: payload.access_token,
    token_type: typeof payload.token_type === "string" ? payload.token_type : undefined,
    expires_in: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
    refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
  };
}

export async function exchangeAuthorizationCode(
  metadata: AuthorizationServerMetadata,
  options: {
    client: OAuthClient;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    resource: string;
  },
) {
  return requestToken(
    metadata,
    {
      grant_type: "authorization_code",
      code: options.code,
      code_verifier: options.codeVerifier,
      redirect_uri: options.redirectUri,
      resource: options.resource,
    },
    options.client,
  );
}

export async function refreshAccessToken(
  metadata: AuthorizationServerMetadata,
  options: { client: OAuthClient; refreshToken: string; resource: string },
) {
  return requestToken(
    metadata,
    {
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      resource: options.resource,
    },
    options.client,
  );
}

export async function revokeToken(
  metadata: AuthorizationServerMetadata,
  options: { client: OAuthClient; token: string },
) {
  if (!metadata.revocation_endpoint) return;
  const body = new URLSearchParams({ token: options.token, client_id: options.client.clientId });
  if (options.client.clientSecret) {
    body.set("client_secret", options.client.clientSecret);
  }
  try {
    await safeFetch(metadata.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch {
    // Revocation is best-effort; the local credentials are deleted regardless.
  }
}
