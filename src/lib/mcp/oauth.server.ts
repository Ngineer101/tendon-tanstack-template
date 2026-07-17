/**
 * PKCE (RFC 7636) helpers and MCP-OAuth authorization URL construction.
 *
 * Pure (no I/O) so the cryptography is trivially unit-testable.
 */
import { ApiError } from "#/lib/api-error";

const PKCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function randomString(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += PKCE_CHARS[bytes[i] % PKCE_CHARS.length];
  return out;
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  method: "S256";
}

export async function generatePkce(): Promise<PkcePair> {
  const codeVerifier = randomString(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  let challenge = "";
  const view = new Uint8Array(digest);
  for (let i = 0; i < view.length; i++) challenge += String.fromCharCode(view[i]);
  return {
    codeVerifier,
    codeChallenge: btoa(challenge).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    method: "S256",
  };
}

export interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  /** Non-standard but commonly present descriptive fields. */
  name?: string;
  description?: string;
  icon_uri?: string;
  bearer_methods_supported?: string[];
}

/**
 * Build the URL the user is redirected to in order to authorize the app at the
 * MCP server's authorization server. All inputs must originate from validated
 * discovery — we never let the client supply an arbitrary `authorization_endpoint`.
 */
export function buildAuthorizationUrl(
  authorizationEndpoint: string,
  params: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes?: string[];
  },
): string {
  if (!authorizationEndpoint) throw new ApiError(502, "MCP server has no authorization endpoint");
  let url: URL;
  try {
    url = new URL(authorizationEndpoint);
  } catch {
    throw new ApiError(502, "MCP server returned an invalid authorization endpoint");
  }
  // Reject endpoints embedding credentials.
  if (url.username || url.password) {
    throw new ApiError(502, "MCP server returned an unsafe authorization endpoint");
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.scopes && params.scopes.length > 0) {
    url.searchParams.set("scope", params.scopes.join(" "));
  }
  url.hash = "";
  return url.href;
}

/** Return only safe, ASCII printable scopes; drop anything weird. */
export function sanitizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return [];
  return scopes
    .filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 128)
    .filter((s) => /^[A-Za-z0-9._:/-]+$/.test(s))
    .slice(0, 32);
}
