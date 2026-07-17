import { MCP_FETCH_TIMEOUT_MS } from "./config.server";
import { sanitizeForLog } from "./url.server";

/**
 * Minimal MCP (Model Context Protocol) client for the Streamable HTTP
 * transport, plus the OAuth 2.0 discovery pieces required by the MCP
 * authorization spec:
 *
 *  - RFC 9728  Protected Resource Metadata (`.well-known/oauth-protected-resource`)
 *  - RFC 8414  Authorization Server Metadata (`.well-known/oauth-authorization-server`)
 *  - RFC 7591  Dynamic Client Registration
 *  - RFC 7636  PKCE (S256)
 *
 * Everything here is server-only: access tokens never leave this module
 * unencrypted, and errors are sanitized before being returned for storage.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "tendon-tanstack-template", version: "1.0.0" };

export class McpAuthRequiredError extends Error {
  constructor(
    message: string,
    public readonly wwwAuthenticate: string | null,
  ) {
    super(message);
    this.name = "McpAuthRequiredError";
  }
}

export class McpRemoteError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(sanitizeForLog(message));
    this.name = "McpRemoteError";
  }
}

export class McpDiscoveryError extends Error {
  constructor(message: string) {
    super(sanitizeForLog(message));
    this.name = "McpDiscoveryError";
  }
}

async function fetchWithTimeout(input: URL | string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", "tendon-mcp-client/1.0");
  try {
    return await fetch(input, {
      ...init,
      headers,
      redirect: "manual", // never follow redirects: prevents credential leakage to third parties
      signal: AbortSignal.timeout(MCP_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new McpRemoteError("The server did not respond in time");
    }
    throw new McpRemoteError("Could not reach the server");
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over Streamable HTTP
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Reads a Streamable HTTP response body. Servers may reply with plain JSON or
 * with a `text/event-stream`; for SSE we return the first `message` event.
 */
async function readJsonRpcMessage(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    for (const block of text.split(/\r?\n\r?\n/)) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (!dataLines.length) continue;
      try {
        return JSON.parse(dataLines.join("\n")) as JsonRpcResponse;
      } catch {
        // keep scanning subsequent events
      }
    }
    throw new McpRemoteError("The server sent an unreadable event stream");
  }

  try {
    return (await response.json()) as JsonRpcResponse;
  } catch {
    throw new McpRemoteError("The server sent an invalid response");
  }
}

async function postJsonRpc(
  serverUrl: URL,
  method: string,
  params: Record<string, unknown>,
  accessToken?: string,
): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const response = await fetchWithTimeout(serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new McpAuthRequiredError(
      "The server requires authorization",
      response.headers.get("www-authenticate"),
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new McpRemoteError("The server tried to redirect the request", response.status);
  }
  if (!response.ok) {
    throw new McpRemoteError(
      `The server responded with status ${response.status}`,
      response.status,
    );
  }

  return readJsonRpcMessage(response);
}

export interface McpServerInfo {
  name?: string;
  version?: string;
}

function unwrapResult(message: JsonRpcResponse): Record<string, unknown> {
  if (message.error) {
    throw new McpRemoteError(`RPC error ${message.error.code}: ${message.error.message}`);
  }
  if (!message.result || typeof message.result !== "object") {
    throw new McpRemoteError("The server sent an empty result");
  }
  return message.result as Record<string, unknown>;
}

/** Performs the MCP `initialize` handshake and returns reported server info. */
export async function initializeServer(
  serverUrl: URL,
  accessToken?: string,
): Promise<McpServerInfo> {
  const message = await postJsonRpc(
    serverUrl,
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
    accessToken,
  );
  const result = unwrapResult(message);
  const serverInfo = (result.serverInfo ?? {}) as Record<string, unknown>;
  return {
    name: typeof serverInfo.name === "string" ? serverInfo.name : undefined,
    version: typeof serverInfo.version === "string" ? serverInfo.version : undefined,
  };
}

/** Lists tools; used by the "test connection" action. */
export async function listTools(
  serverUrl: URL,
  accessToken?: string,
): Promise<{ toolCount: number }> {
  const message = await postJsonRpc(serverUrl, "tools/list", {}, accessToken);
  const result = unwrapResult(message);
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return { toolCount: tools.length };
}

// ---------------------------------------------------------------------------
// OAuth discovery (RFC 9728 + RFC 8414)
// ---------------------------------------------------------------------------

export interface OAuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported: string[];
}

/** Parses `WWW-Authenticate: Bearer resource_metadata="..."` challenges. */
export function parseResourceMetadataUrl(serverUrl: URL, wwwAuthenticate: string | null): URL {
  const fallback = new URL(
    "/.well-known/oauth-protected-resource",
    `${serverUrl.protocol}//${serverUrl.host}`,
  );
  if (!wwwAuthenticate) return fallback;

  const match = /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate);
  if (!match) return fallback;
  try {
    const metadataUrl = new URL(match[1]);
    if (metadataUrl.protocol !== "https:") return fallback;
    return metadataUrl;
  } catch {
    return fallback;
  }
}

function assertHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string") throw new McpDiscoveryError(`Missing ${field} in OAuth metadata`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new McpDiscoveryError(`Invalid ${field} in OAuth metadata`);
  }
  if (parsed.protocol !== "https:") {
    throw new McpDiscoveryError(`Refusing non-https ${field}`);
  }
  return value;
}

async function fetchJson(url: URL): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new McpDiscoveryError(`Metadata request failed with status ${response.status}`);
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new McpDiscoveryError("Metadata response was not valid JSON");
  }
}

function metadataUrlsForIssuer(issuer: string): URL[] {
  const issuerUrl = new URL(issuer);
  const path = issuerUrl.pathname.replace(/\/+$/, "");
  const base = `${issuerUrl.protocol}//${issuerUrl.host}`;
  const urls = [
    // RFC 8414: well-known segment is inserted before the path.
    new URL(`/.well-known/oauth-authorization-server${path}`, base),
    // OIDC discovery style: appended after the path.
    new URL(`${path}/.well-known/oauth-authorization-server`, base),
    new URL(`${path}/.well-known/openid-configuration`, base),
  ];
  return [...new Map(urls.map((url) => [url.href, url])).values()];
}

/**
 * Discovers the OAuth authorization server protecting the given MCP server.
 * Throws `McpDiscoveryError` when no usable metadata can be found.
 */
export async function discoverOAuthServer(
  serverUrl: URL,
  wwwAuthenticate: string | null,
): Promise<OAuthServerMetadata> {
  const resourceMetadataUrl = parseResourceMetadataUrl(serverUrl, wwwAuthenticate);
  const resourceMetadata = await fetchJson(resourceMetadataUrl).catch((error: unknown) => {
    if (wwwAuthenticate) throw error;
    throw new McpDiscoveryError("The server does not publish OAuth protected-resource metadata");
  });

  const authorizationServers = Array.isArray(resourceMetadata.authorization_servers)
    ? resourceMetadata.authorization_servers.filter(
        (entry): entry is string => typeof entry === "string" && entry.startsWith("https://"),
      )
    : [];
  if (!authorizationServers.length) {
    throw new McpDiscoveryError("The server does not list an authorization server");
  }

  let lastError: unknown;
  for (const issuer of authorizationServers) {
    for (const metadataUrl of metadataUrlsForIssuer(issuer)) {
      try {
        const metadata = await fetchJson(metadataUrl);
        return {
          issuer,
          authorizationEndpoint: assertHttpsUrl(
            metadata.authorization_endpoint,
            "authorization_endpoint",
          ),
          tokenEndpoint: assertHttpsUrl(metadata.token_endpoint, "token_endpoint"),
          registrationEndpoint:
            typeof metadata.registration_endpoint === "string" &&
            metadata.registration_endpoint.startsWith("https://")
              ? metadata.registration_endpoint
              : undefined,
          scopesSupported: Array.isArray(metadata.scopes_supported)
            ? metadata.scopes_supported.filter(
                (scope): scope is string => typeof scope === "string",
              )
            : [],
        };
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new McpDiscoveryError("OAuth discovery failed for every authorization server");
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591) + PKCE (RFC 7636)
// ---------------------------------------------------------------------------

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<RegisteredClient> {
  const response = await fetchWithTimeout(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) {
    throw new McpDiscoveryError(`Client registration failed with status ${response.status}`);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.client_id !== "string" || !body.client_id) {
    throw new McpDiscoveryError("Client registration did not return a client_id");
  }
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === "string" ? body.client_secret : undefined,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildAuthorizationUrl(
  metadata: OAuthServerMetadata,
  options: { clientId: string; redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export interface TokenBundle {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds when the access token expires; undefined if unknown. */
  expiresAt?: number;
  tokenType: string;
  scope?: string;
}

async function callTokenEndpoint(
  tokenEndpoint: string,
  params: Record<string, string>,
): Promise<TokenBundle> {
  const response = await fetchWithTimeout(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const description =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : `status ${response.status}`;
    throw new McpRemoteError(`Token request failed: ${description}`, response.status);
  }
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new McpRemoteError("Token response did not include an access token");
  }

  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresAt:
      typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}

export function exchangeAuthorizationCode(
  metadata: OAuthServerMetadata,
  options: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    codeVerifier: string;
  },
): Promise<TokenBundle> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.codeVerifier,
  };
  if (options.clientSecret) params.client_secret = options.clientSecret;
  return callTokenEndpoint(metadata.tokenEndpoint, params);
}

export function refreshAccessToken(
  tokenEndpoint: string,
  options: { refreshToken: string; clientId: string; clientSecret?: string },
): Promise<TokenBundle> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  };
  if (options.clientSecret) params.client_secret = options.clientSecret;
  return callTokenEndpoint(tokenEndpoint, params);
}
