// MCP OAuth discovery (RFC 8414 authorization server metadata) + the OAuth
// 2.1 PKCE flow used to connect a user-owned MCP server.
//
// Flow:
//   1. `discoverOAuthMetadata(env, serverUrl)` GETs
//      `${serverUrl}/.well-known/oauth-authorization-server` and returns the
//      authorization/token/registration endpoints. Throws a 424 when the
//      server advertises no OAuth metadata.
//   2. When the user starts the connect, `buildAuthorizationUrl` builds the
//      authorization URL for a PKCE (S256) flow using a stored state +
//      code_verifier. The caller persists both in `mcp_oauth_state`.
//   3. The user is redirected to their MCP server, authorizes, and is sent
//      back to `/api/mcp/oauth/callback` with `code` + `state`.
//   4. `exchangeCode` POSTs to the token endpoint with the code + verifier,
//      returns the token set, and the caller encrypts it at rest.
//
// PKCE (S256) is used so we do not need a stored client secret for the user's
// MCP server. If the server supports Dynamic Client Registration
// (RFC 7591), we register a client on the fly and store its credentials
// (encrypted) alongside the tokens.

import { ApiError } from "#/lib/api-error";
import { type McpEnv, MCP_DEFAULT_SCOPE, MCP_FETCH_TIMEOUT_MS } from "./config.server";
import { safeFetch, validateFetchUrl } from "./ssrf.server";

export interface OAuthMetadata {
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  responseTypesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  grantTypesSupported?: string[];
}

export interface StoredAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  tokenType?: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

// 43-128 char random base64url string (PKCE verifier / OAuth state).
export function randomBase64Url(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function codeVerifierToChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function shouldAllowLocalhost(env: McpEnv): boolean {
  try {
    return new URL(env.BETTER_AUTH_URL).hostname === "localhost";
  } catch {
    return false;
  }
}

// Fetch and parse MCP authorization server metadata.
export async function discoverOAuthMetadata(
  env: McpEnv,
  serverUrl: string,
  appOrigin: string,
): Promise<OAuthMetadata> {
  const metadataUrl = `${serverUrl.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
  const response = await safeFetch(
    metadataUrl,
    {
      method: "GET",
      timeoutMs: MCP_FETCH_TIMEOUT_MS,
      headers: { accept: "application/json" },
    },
    { allowLocalhost: shouldAllowLocalhost(env), appOrigin, maxRedirects: 2 },
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new ApiError(424, "This MCP server does not advertise OAuth metadata");
    }
    throw new ApiError(502, `MCP server metadata request failed (HTTP ${response.status})`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError(502, "MCP server returned invalid OAuth metadata");
  }
  const metadata = (json ?? {}) as Record<string, unknown>;
  if (!metadata || typeof metadata !== "object") {
    throw new ApiError(502, "MCP server returned invalid OAuth metadata");
  }
  const auth = metadata.authorization_endpoint;
  const token = metadata.token_endpoint;
  if (typeof auth !== "string" || typeof token !== "string") {
    throw new ApiError(424, "This MCP server's OAuth metadata is incomplete");
  }

  // The endpoints themselves must be https (or localhost in dev) and not point
  // at a blocked host.
  validateFetchUrl(auth, { allowLocalhost: shouldAllowLocalhost(env) });
  validateFetchUrl(token, { allowLocalhost: shouldAllowLocalhost(env) });

  return {
    authorizationEndpoint: auth,
    tokenEndpoint: token,
    registrationEndpoint:
      typeof metadata.registration_endpoint === "string"
        ? metadata.registration_endpoint
        : undefined,
    scopesSupported: Array.isArray(metadata.scopes_supported)
      ? (metadata.scopes_supported as string[])
      : undefined,
    responseTypesSupported: Array.isArray(metadata.response_types_supported)
      ? (metadata.response_types_supported as string[])
      : undefined,
    codeChallengeMethodsSupported: Array.isArray(metadata.code_challenge_methods_supported)
      ? (metadata.code_challenge_methods_supported as string[])
      : undefined,
    grantTypesSupported: Array.isArray(metadata.grant_types_supported)
      ? (metadata.grant_types_supported as string[])
      : undefined,
  };
}

export interface StartAuthInput {
  codeVerifier: string;
  state: string;
  metadata: OAuthMetadata;
  redirectUri: string;
}

export async function buildAuthorizationUrl(input: StartAuthInput): Promise<string> {
  const url = new URL(input.metadata.authorizationEndpoint as string);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", await codeVerifierToChallenge(input.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("redirect_uri", input.redirectUri);
  if (!url.searchParams.has("scope")) {
    url.searchParams.set("scope", MCP_DEFAULT_SCOPE);
  }
  return url.toString();
}

// Optional Dynamic Client Registration (RFC 7591). Returns client credentials
// to store with the token set. Soft-fails (returns undefined) so the flow can
// fall back to a public PKCE-only client.
export async function registerDynamicClient(
  env: McpEnv,
  metadata: OAuthMetadata,
  redirectUri: string,
  appOrigin: string,
): Promise<{ clientId: string; clientSecret?: string } | undefined> {
  if (!metadata.registrationEndpoint) return undefined;
  const response = await safeFetch(
    metadata.registrationEndpoint,
    {
      method: "POST",
      timeoutMs: MCP_FETCH_TIMEOUT_MS,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    },
    { allowLocalhost: shouldAllowLocalhost(env), appOrigin, maxRedirects: 2 },
  );
  if (!response.ok) return undefined;
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return undefined;
  }
  const data = (json ?? {}) as Record<string, unknown>;
  if (typeof data.client_id !== "string") return undefined;
  return {
    clientId: data.client_id,
    clientSecret: typeof data.client_secret === "string" ? data.client_secret : undefined,
  };
}

// Exchange the authorization code for tokens. Enforces a JSON body and
// validates the response shape.
export async function exchangeCode(
  env: McpEnv,
  args: {
    metadata: OAuthMetadata;
    redirectUri: string;
    auth: { clientId?: string; clientSecret?: string };
    code: string;
    codeVerifier: string;
    appOrigin: string;
  },
): Promise<StoredAuth> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
  if (args.auth.clientId) body.set("client_id", args.auth.clientId);
  if (args.auth.clientSecret) body.set("client_secret", args.auth.clientSecret);

  const response = await safeFetch(
    args.metadata.tokenEndpoint as string,
    {
      method: "POST",
      timeoutMs: MCP_FETCH_TIMEOUT_MS,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    { allowLocalhost: shouldAllowLocalhost(env), maxRedirects: 2, appOrigin: args.appOrigin },
  );

  if (!response.ok) {
    throw new ApiError(502, "The MCP server rejected the authorization code");
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError(502, "The MCP server returned an invalid token response");
  }
  const token = (json ?? {}) as TokenResponse;
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new ApiError(502, "The MCP server did not return an access token");
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    tokenType: token.token_type,
    scope: token.scope,
    clientId: args.auth.clientId,
    clientSecret: args.auth.clientSecret,
  };
}
