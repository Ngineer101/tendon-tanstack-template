import { ApiError } from "#/lib/api-error";
import type { McpServerInfo } from "./config";
import { assertSafeExternalUrl, safeFetch, type UrlSecurityOptions } from "./url-security.server";

// OAuth 2.1 client for MCP servers, following the MCP authorization spec:
// protected-resource metadata discovery (RFC 9728), authorization-server
// metadata (RFC 8414), dynamic client registration (RFC 7591), PKCE, and
// resource indicators (RFC 8707).

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "Tendon dashboard";

// Non-secret OAuth configuration persisted per server (mcp_server.oauth_config).
export interface McpOauthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scope: string | null;
  resource: string;
  clientId: string;
}

export interface McpTokenSet {
  accessToken: string;
  refreshToken: string | null;
  // Epoch milliseconds; null when the server did not report an expiry.
  expiresAt: number | null;
}

// Everything secret for a server, stored AES-GCM encrypted (mcp_server.auth_data).
export interface McpAuthData {
  clientSecret?: string;
  tokens?: McpTokenSet;
}

export function parseWwwAuthenticate(header: string | null): {
  resourceMetadataUrl: string | null;
} {
  if (!header) return { resourceMetadataUrl: null };
  const match = /resource_metadata="([^"]+)"/i.exec(header);
  return { resourceMetadataUrl: match?.[1] ?? null };
}

// RFC 8707 canonical resource identifier: lowercase scheme/host, no fragment,
// no trailing slash on the root path.
export function canonicalResource(serverUrl: URL): string {
  const pathname = serverUrl.pathname === "/" ? "" : serverUrl.pathname;
  return `${serverUrl.origin.toLowerCase()}${pathname}${serverUrl.search}`;
}

async function fetchJsonMetadata(
  url: string,
  options: UrlSecurityOptions,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await safeFetch(
      url,
      { method: "GET", headers: { accept: "application/json" } },
      options,
    );
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function wellKnownCandidates(base: URL, suffixes: string[]): string[] {
  const candidates: string[] = [];
  const path = base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
  for (const suffix of suffixes) {
    if (path) candidates.push(`${base.origin}/.well-known/${suffix}${path}`);
    candidates.push(`${base.origin}/.well-known/${suffix}`);
  }
  return candidates;
}

export interface DiscoveredEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scope: string | null;
  resource: string;
}

// Discovers the authorization configuration for an MCP server that returned
// 401. Falls back to the legacy MCP default endpoints when no metadata is
// published.
export async function discoverOauthEndpoints(
  serverUrl: URL,
  wwwAuthenticate: string | null,
  options: UrlSecurityOptions,
): Promise<DiscoveredEndpoints> {
  const { resourceMetadataUrl } = parseWwwAuthenticate(wwwAuthenticate);

  const resourceMetadataCandidates = [
    ...(resourceMetadataUrl ? [resourceMetadataUrl] : []),
    ...wellKnownCandidates(serverUrl, ["oauth-protected-resource"]),
  ];

  let issuer = serverUrl.origin;
  let scope: string | null = null;
  for (const candidate of resourceMetadataCandidates) {
    const metadata = await fetchJsonMetadata(candidate, options);
    const authorizationServers = metadata?.authorization_servers;
    if (Array.isArray(authorizationServers) && typeof authorizationServers[0] === "string") {
      issuer = authorizationServers[0];
      if (Array.isArray(metadata?.scopes_supported)) {
        scope = metadata.scopes_supported.filter((s) => typeof s === "string").join(" ") || null;
      }
      break;
    }
  }

  const issuerUrl = assertSafeExternalUrl(issuer, options);
  const authServerCandidates = wellKnownCandidates(issuerUrl, [
    "oauth-authorization-server",
    "openid-configuration",
  ]);

  for (const candidate of authServerCandidates) {
    const metadata = await fetchJsonMetadata(candidate, options);
    if (
      typeof metadata?.authorization_endpoint === "string" &&
      typeof metadata.token_endpoint === "string"
    ) {
      const authorizationEndpoint = assertSafeExternalUrl(
        metadata.authorization_endpoint,
        options,
      ).toString();
      const tokenEndpoint = assertSafeExternalUrl(metadata.token_endpoint, options).toString();
      const registrationEndpoint =
        typeof metadata.registration_endpoint === "string"
          ? assertSafeExternalUrl(metadata.registration_endpoint, options).toString()
          : null;
      return {
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint,
        scope,
        resource: canonicalResource(serverUrl),
      };
    }
  }

  // Legacy fallback from the 2024-11-05 MCP authorization spec.
  return {
    authorizationEndpoint: `${issuerUrl.origin}/authorize`,
    tokenEndpoint: `${issuerUrl.origin}/token`,
    registrationEndpoint: `${issuerUrl.origin}/register`,
    scope,
    resource: canonicalResource(serverUrl),
  };
}

export async function registerOauthClient(
  endpoints: DiscoveredEndpoints,
  redirectUri: string,
  options: UrlSecurityOptions,
): Promise<{ clientId: string; clientSecret: string | null }> {
  if (!endpoints.registrationEndpoint) {
    throw new ApiError(
      502,
      "This MCP server requires OAuth but does not support automatic client registration",
    );
  }

  const response = await safeFetch(
    endpoints.registrationEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(endpoints.scope ? { scope: endpoints.scope } : {}),
      }),
    },
    options,
  );

  if (!response.ok) {
    throw new ApiError(
      502,
      `The authorization server rejected client registration (HTTP ${response.status})`,
    );
  }

  const body = (await response.json()) as { client_id?: string; client_secret?: string };
  if (!body.client_id) {
    throw new ApiError(502, "The authorization server returned an invalid registration response");
  }

  return { clientId: body.client_id, clientSecret: body.client_secret ?? null };
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function createOauthState(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

export function buildAuthorizationUrl(
  config: McpOauthConfig,
  params: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", config.resource);
  if (config.scope) url.searchParams.set("scope", config.scope);
  return url.toString();
}

interface TokenRequestParams {
  config: McpOauthConfig;
  clientSecret: string | null;
  grant: Record<string, string>;
  options: UrlSecurityOptions;
}

async function requestTokens({
  config,
  clientSecret,
  grant,
  options,
}: TokenRequestParams): Promise<McpTokenSet> {
  const body = new URLSearchParams({
    ...grant,
    client_id: config.clientId,
    resource: config.resource,
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const response = await safeFetch(
    config.tokenEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    },
    options,
  );

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errorBody = (await response.json()) as { error?: string; error_description?: string };
      if (typeof errorBody.error === "string") {
        // Only the OAuth error code and a truncated description; never token material.
        detail = [errorBody.error, errorBody.error_description?.slice(0, 200)]
          .filter(Boolean)
          .join(": ");
      }
    } catch {
      // Ignore unparseable error bodies.
    }
    throw new ApiError(502, `Token request failed (${detail})`);
  }

  const tokens = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokens.access_token) {
    throw new ApiError(502, "The authorization server returned an invalid token response");
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : null,
  };
}

export function exchangeAuthorizationCode(
  config: McpOauthConfig,
  params: { code: string; codeVerifier: string; redirectUri: string; clientSecret: string | null },
  options: UrlSecurityOptions,
): Promise<McpTokenSet> {
  return requestTokens({
    config,
    clientSecret: params.clientSecret,
    grant: {
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    },
    options,
  });
}

export function refreshAccessToken(
  config: McpOauthConfig,
  params: { refreshToken: string; clientSecret: string | null },
  options: UrlSecurityOptions,
): Promise<McpTokenSet> {
  return requestTokens({
    config,
    clientSecret: params.clientSecret,
    grant: { grant_type: "refresh_token", refresh_token: params.refreshToken },
    options,
  });
}

export type McpProbeResult =
  | { kind: "ok"; serverInfo: McpServerInfo | null }
  | { kind: "unauthorized"; wwwAuthenticate: string | null }
  | { kind: "error"; message: string };

function extractServerInfo(payload: unknown): McpServerInfo | null {
  if (typeof payload !== "object" || payload === null) return null;
  const result = (payload as { result?: { serverInfo?: McpServerInfo } }).result;
  const serverInfo = result?.serverInfo;
  if (!serverInfo || typeof serverInfo !== "object") return null;
  return {
    ...(typeof serverInfo.name === "string" ? { name: serverInfo.name } : {}),
    ...(typeof serverInfo.version === "string" ? { version: serverInfo.version } : {}),
  };
}

// Sends a JSON-RPC `initialize` request over Streamable HTTP to check whether
// the server is reachable and whether the supplied token (if any) works.
export async function probeMcpServer(
  serverUrl: URL,
  accessToken: string | null,
  options: UrlSecurityOptions,
): Promise<McpProbeResult> {
  let response: Response;
  try {
    response = await safeFetch(
      serverUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
          },
        }),
      },
      options,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) throw error;
    return {
      kind: "error",
      message:
        error instanceof ApiError ? error.message : "Could not reach the server (network error)",
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized", wwwAuthenticate: response.headers.get("www-authenticate") };
  }

  if (!response.ok) {
    return { kind: "error", message: `The server responded with HTTP ${response.status}` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
      return {
        kind: "ok",
        serverInfo: dataLine ? extractServerInfo(JSON.parse(dataLine.slice(5).trim())) : null,
      };
    }
    return { kind: "ok", serverInfo: extractServerInfo(await response.json()) };
  } catch {
    // Reachable but responded with an unexpected body; still treat as online.
    return { kind: "ok", serverInfo: null };
  }
}
