import { validateRedirectUrl } from "./url-validator";

export interface OAuthMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopesSupported?: string[];
  responseTypesSupported?: string[];
}

export interface OAuthState {
  codeVerifier: string;
  codeChallenge: string;
  serverOrigin: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope: string;
  state: string;
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(43));

  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

  let result = "";
  for (const byte of bytes) {
    result += charset[byte % charset.length];
  }
  return result;
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64UrlEncode(hash);
}

export function generateState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return base64UrlEncode(bytes.buffer);
}

const OIDC_DISCOVERY_PATH = "/.well-known/openid-configuration";
const OAUTH_METADATA_PATH = "/.well-known/oauth-authorization-server";

export async function discoverOAuthMetadata(serverOrigin: string): Promise<OAuthMetadata | null> {
  const paths = [OIDC_DISCOVERY_PATH, OAUTH_METADATA_PATH];

  for (const path of paths) {
    try {
      const response = await fetch(`${serverOrigin}${path}`, {
        signal: AbortSignal.timeout(5000),
        headers: { accept: "application/json" },
      });

      if (!response.ok) continue;

      const metadata = (await response.json()) as Record<string, unknown>;

      if (
        typeof metadata.authorization_endpoint === "string" &&
        typeof metadata.token_endpoint === "string"
      ) {
        const authEndpoint = new URL(String(metadata.authorization_endpoint), serverOrigin).href;
        const tokenEndpoint = new URL(String(metadata.token_endpoint), serverOrigin).href;

        if (
          !validateRedirectUrl(serverOrigin, authEndpoint) ||
          !validateRedirectUrl(serverOrigin, tokenEndpoint)
        ) {
          continue;
        }

        return {
          issuer: typeof metadata.issuer === "string" ? metadata.issuer : serverOrigin,
          authorizationEndpoint: authEndpoint,
          tokenEndpoint,
          scopesSupported: Array.isArray(metadata.scopes_supported)
            ? (metadata.scopes_supported as string[])
            : undefined,
          responseTypesSupported: Array.isArray(metadata.response_types_supported)
            ? (metadata.response_types_supported as string[])
            : undefined,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function createOAuthState(
  serverOrigin: string,
  metadata: OAuthMetadata,
  clientId: string,
  scope: string,
): Promise<OAuthState> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  return {
    codeVerifier,
    codeChallenge,
    serverOrigin,
    authorizationEndpoint: metadata.authorizationEndpoint,
    tokenEndpoint: metadata.tokenEndpoint,
    clientId,
    scope,
    state,
  };
}

export function buildAuthorizationUrl(oauthState: OAuthState, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: oauthState.clientId,
    code_challenge: oauthState.codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    state: oauthState.state,
    scope: oauthState.scope,
  });

  return `${oauthState.authorizationEndpoint}?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  oauthState: { tokenEndpoint: string; clientId: string; codeVerifier: string },
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: oauthState.clientId,
    code_verifier: oauthState.codeVerifier,
  });

  const response = await fetch(oauthState.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(
      `Token exchange failed with status ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error("No access token in token response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

export async function refreshAccessToken(
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(
      `Token refresh failed with status ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error("No access token in refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}
