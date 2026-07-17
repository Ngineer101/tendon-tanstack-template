import { ApiError } from "#/lib/api-error";
import { MCP_ERROR_CODES } from "./config";
import { assertSafePublicUrl, type UrlGuardOptions } from "./url-guard.server";

// MCP Streamable HTTP probing plus OAuth 2.1 discovery (RFC 9728 protected
// resource metadata, RFC 8414 authorization server metadata, RFC 7591 dynamic
// client registration, RFC 7636 PKCE, RFC 8707 resource indicators).

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 10_000;
const CLIENT_NAME = "Tendon";

export interface McpFetchOptions {
  fetchFn?: typeof fetch;
  allowPrivateNetwork?: boolean;
}

export type ProbeResult =
  | {
      status: "ok";
      serverName?: string;
      serverVersion?: string;
      toolCount?: number;
    }
  | {
      status: "auth_required";
      resourceMetadataUrl?: string;
    };

export interface OAuthDiscovery {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string[];
  clientId?: string;
}

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  scope?: string;
  // Epoch milliseconds; undefined when the server did not report expiry.
  expiresAt?: number;
}

function guardOptions(options: McpFetchOptions, purpose: string): UrlGuardOptions {
  return { allowPrivateNetwork: options.allowPrivateNetwork, purpose };
}

async function safeFetch(
  url: string,
  init: RequestInit,
  options: McpFetchOptions,
  purpose: string,
): Promise<Response> {
  assertSafePublicUrl(url, guardOptions(options, purpose));
  const fetchFn = options.fetchFn ?? fetch;
  try {
    return await fetchFn(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Never surface raw network errors: they can embed the full URL (with query).
    throw new ApiError(502, `${purpose} did not respond`, { code: MCP_ERROR_CODES.unreachable });
  }
}

// Reads a single JSON-RPC response from a Streamable HTTP response, which may be
// plain JSON or an SSE stream. Stops reading as soon as the matching id arrives
// so an open event stream cannot hang the request.
async function readJsonRpcResponse(
  response: Response,
  id: number,
): Promise<Record<string, unknown> | undefined> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await response.json()) as Record<string, unknown>;
    return body.id === id ? body : undefined;
  }

  if (!contentType.includes("text/event-stream") || !response.body) return undefined;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      // SSE allows \r\n, \r, or \n line endings (some servers emit CRLF).
      const events = buffer.split(/\r\n\r\n|\n\n|\r\r/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event
          .split(/\r\n|\n|\r/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data) continue;
        try {
          const message = JSON.parse(data) as Record<string, unknown>;
          if (message.id === id) return message;
        } catch {
          // Ignore non-JSON events.
        }
      }
      if (done) return undefined;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Extracts resource_metadata from a WWW-Authenticate challenge (RFC 9728 §5.1).
export function parseResourceMetadataUrl(wwwAuthenticate: string | null): string | undefined {
  if (!wwwAuthenticate) return undefined;
  const match = /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate);
  return match?.[1];
}

interface JsonRpcRequestInit {
  method: string;
  params?: Record<string, unknown>;
  accessToken?: string;
  sessionId?: string;
  id: number;
}

async function sendJsonRpc(
  serverUrl: string,
  { method, params, accessToken, sessionId, id }: JsonRpcRequestInit,
  options: McpFetchOptions,
): Promise<Response> {
  return safeFetch(
    serverUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
    },
    options,
    "MCP server",
  );
}

export async function probeMcpServer(
  serverUrl: string,
  accessToken: string | undefined,
  options: McpFetchOptions = {},
): Promise<ProbeResult> {
  const response = await sendJsonRpc(
    serverUrl,
    {
      id: 1,
      method: "initialize",
      accessToken,
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
      },
    },
    options,
  );

  if (response.status === 401) {
    await response.body?.cancel().catch(() => {});
    return {
      status: "auth_required",
      resourceMetadataUrl: parseResourceMetadataUrl(response.headers.get("www-authenticate")),
    };
  }

  if (response.status >= 300 && response.status < 400) {
    throw new ApiError(502, "MCP server redirected the request; redirects are not followed", {
      code: MCP_ERROR_CODES.unreachable,
    });
  }

  if (!response.ok) {
    throw new ApiError(502, `MCP server responded with status ${response.status}`, {
      code: MCP_ERROR_CODES.unreachable,
    });
  }

  const message = await readJsonRpcResponse(response, 1);
  const result = message?.result as
    | { serverInfo?: { name?: string; version?: string } }
    | undefined;
  if (!result) {
    throw new ApiError(502, "MCP server returned an unexpected initialize response", {
      code: MCP_ERROR_CODES.unreachable,
    });
  }

  const probe: ProbeResult = {
    status: "ok",
    serverName: result.serverInfo?.name,
    serverVersion: result.serverInfo?.version,
  };

  // Tool count is best-effort; a server that rejects tools/list is still connected.
  try {
    const sessionId = response.headers.get("mcp-session-id") ?? undefined;
    await sendJsonRpc(
      serverUrl,
      { id: 0, method: "notifications/initialized", accessToken, sessionId },
      options,
    ).then((res) => res.body?.cancel().catch(() => {}));
    const toolsResponse = await sendJsonRpc(
      serverUrl,
      { id: 2, method: "tools/list", accessToken, sessionId },
      options,
    );
    if (toolsResponse.ok) {
      const toolsMessage = await readJsonRpcResponse(toolsResponse, 2);
      const tools = (toolsMessage?.result as { tools?: unknown[] } | undefined)?.tools;
      if (Array.isArray(tools)) probe.toolCount = tools.length;
    } else {
      await toolsResponse.body?.cancel().catch(() => {});
    }
  } catch {
    // Ignore: tool listing is informational only.
  }

  return probe;
}

async function fetchJson(
  url: string,
  options: McpFetchOptions,
  purpose: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await safeFetch(
    url,
    { headers: { accept: "application/json" } },
    options,
    purpose,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function wellKnownCandidates(baseUrl: URL, suffix: string): string[] {
  const path = baseUrl.pathname.replace(/\/+$/, "");
  const candidates = [`${baseUrl.origin}/.well-known/${suffix}${path}`];
  if (path) candidates.push(`${baseUrl.origin}/.well-known/${suffix}`);
  return candidates;
}

export async function discoverOAuthConfig(
  serverUrl: string,
  resourceMetadataUrl: string | undefined,
  options: McpFetchOptions = {},
): Promise<OAuthDiscovery> {
  const server = assertSafePublicUrl(serverUrl, guardOptions(options, "Server URL"));

  // 1. Protected resource metadata -> authorization server issuer.
  const metadataCandidates = resourceMetadataUrl
    ? [resourceMetadataUrl]
    : wellKnownCandidates(server, "oauth-protected-resource");

  let issuer = server.origin;
  let scopes: string[] | undefined;
  for (const candidate of metadataCandidates) {
    const metadata = await fetchJson(candidate, options, "OAuth resource metadata");
    const authorizationServers = metadata?.authorization_servers;
    if (Array.isArray(authorizationServers) && typeof authorizationServers[0] === "string") {
      issuer = authorizationServers[0];
      if (Array.isArray(metadata?.scopes_supported)) {
        scopes = metadata.scopes_supported.filter((s): s is string => typeof s === "string");
      }
      break;
    }
  }

  // 2. Authorization server metadata.
  const issuerUrl = assertSafePublicUrl(issuer, guardOptions(options, "Authorization server URL"));
  const issuerPath = issuerUrl.pathname.replace(/\/+$/, "");
  const authMetadataCandidates = [
    ...wellKnownCandidates(issuerUrl, "oauth-authorization-server"),
    ...wellKnownCandidates(issuerUrl, "openid-configuration"),
    ...(issuerPath ? [`${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`] : []),
  ];

  for (const candidate of authMetadataCandidates) {
    const metadata = await fetchJson(candidate, options, "OAuth server metadata");
    if (
      typeof metadata?.authorization_endpoint === "string" &&
      typeof metadata.token_endpoint === "string"
    ) {
      assertSafePublicUrl(
        metadata.authorization_endpoint,
        guardOptions(options, "Authorization endpoint"),
      );
      assertSafePublicUrl(metadata.token_endpoint, guardOptions(options, "Token endpoint"));
      const registrationEndpoint =
        typeof metadata.registration_endpoint === "string"
          ? metadata.registration_endpoint
          : undefined;
      if (registrationEndpoint) {
        assertSafePublicUrl(registrationEndpoint, guardOptions(options, "Registration endpoint"));
      }
      if (!scopes && Array.isArray(metadata.scopes_supported)) {
        scopes = metadata.scopes_supported.filter((s): s is string => typeof s === "string");
      }
      return {
        resource: serverUrl,
        issuer,
        authorizationEndpoint: metadata.authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
        registrationEndpoint,
        scopes,
      };
    }
  }

  throw new ApiError(
    502,
    "This server requires authorization but does not expose OAuth discovery metadata",
    { code: MCP_ERROR_CODES.oauth_discovery_failed },
  );
}

export async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
  options: McpFetchOptions = {},
): Promise<{ clientId: string; clientSecret?: string }> {
  const response = await safeFetch(
    registrationEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    },
    options,
    "OAuth registration endpoint",
  );

  const body = (await response.json().catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;
  if (!response.ok || typeof body?.client_id !== "string") {
    throw new ApiError(502, "The authorization server rejected client registration", {
      code: MCP_ERROR_CODES.oauth_registration_failed,
    });
  }

  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === "string" ? body.client_secret : undefined,
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  scopes?: string[];
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);
  if (input.scopes?.length) url.searchParams.set("scope", input.scopes.join(" "));
  return url.toString();
}

interface TokenRequestAuth {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
}

async function requestTokens(
  auth: TokenRequestAuth,
  grant: Record<string, string>,
  options: McpFetchOptions,
): Promise<TokenSet> {
  const params = new URLSearchParams({ ...grant, resource: auth.resource });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (auth.clientSecret) {
    headers.authorization = `Basic ${btoa(`${auth.clientId}:${auth.clientSecret}`)}`;
  } else {
    params.set("client_id", auth.clientId);
  }

  const response = await safeFetch(
    auth.tokenEndpoint,
    { method: "POST", headers, body: params.toString() },
    options,
    "OAuth token endpoint",
  );

  const body = (await response.json().catch(() => undefined)) as
    | Record<string, unknown>
    | undefined;
  if (!response.ok || typeof body?.access_token !== "string") {
    // Only surface the standard OAuth error code; the raw body may echo credentials.
    const errorCode = typeof body?.error === "string" ? body.error.slice(0, 40) : "unknown_error";
    throw new ApiError(502, `Token request failed (${errorCode})`, {
      code: MCP_ERROR_CODES.oauth_exchange_failed,
    });
  }

  return {
    accessToken: body.access_token,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    expiresAt:
      typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
        ? Date.now() + body.expires_in * 1000
        : undefined,
  };
}

export async function exchangeAuthorizationCode(
  auth: TokenRequestAuth,
  input: { code: string; redirectUri: string; codeVerifier: string },
  options: McpFetchOptions = {},
): Promise<TokenSet> {
  return requestTokens(
    auth,
    {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    },
    options,
  );
}

export async function refreshAccessToken(
  auth: TokenRequestAuth,
  refreshToken: string,
  options: McpFetchOptions = {},
): Promise<TokenSet> {
  return requestTokens(auth, { grant_type: "refresh_token", refresh_token: refreshToken }, options);
}
