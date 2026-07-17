import { ApiError } from "#/lib/api-error";
import type { OAuthServerMetadata } from "./discovery.server";

/**
 * OAuth 2.1 helpers for the MCP authorization flow: PKCE, dynamic client
 * registration (RFC 7591), authorization URL construction, and the token
 * exchange. All functions avoid logging or returning credential material.
 */

const TOKEN_TIMEOUT_MS = 8_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function generateState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export interface ClientRegistration {
  clientId: string;
  clientSecret?: string;
}

/**
 * Registers this application as a public client with the issuer (RFC 7591).
 * Throws ApiError(502) with a sanitized message on failure.
 */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<ClientRegistration> {
  let response: Response;
  try {
    response = await fetchImpl(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Tendon",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(502, "Unable to register with the MCP server's authorization server");
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(
      502,
      "The MCP server's authorization server rejected dynamic client registration",
    );
  }

  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).client_id !== "string"
  ) {
    throw new ApiError(502, "The authorization server returned an invalid client registration");
  }

  const record = body as Record<string, unknown>;
  return {
    clientId: record.client_id as string,
    clientSecret: typeof record.client_secret === "string" ? record.client_secret : undefined,
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

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Unix epoch milliseconds when the access token expires, if known. */
  expiresAt?: number;
  scope?: string;
  tokenType: string;
}

/**
 * Exchanges an authorization code for tokens using PKCE. Error messages are
 * deliberately limited to standard OAuth error codes so token material and
 * free-text server responses never reach logs or the client.
 */
export async function exchangeCode(
  tokenEndpoint: string,
  params: {
    code: string;
    verifier: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    resource: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.verifier,
    resource: params.resource,
  });
  if (params.clientSecret) body.set("client_secret", params.clientSecret);

  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(502, "Unable to reach the authorization server's token endpoint");
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    // Only propagate standard, non-sensitive OAuth error codes.
    const code =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).error
        : undefined;
    const safeCode = typeof code === "string" && /^[a-z_]+$/.test(code) ? code : "unknown";
    throw new ApiError(502, `Token exchange failed (${safeCode})`);
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>).access_token !== "string"
  ) {
    throw new ApiError(502, "The authorization server returned an invalid token response");
  }

  const record = payload as Record<string, unknown>;
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : undefined;
  return {
    accessToken: record.access_token as string,
    refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    scope: typeof record.scope === "string" ? record.scope : undefined,
    tokenType: typeof record.token_type === "string" ? record.token_type : "Bearer",
  };
}
