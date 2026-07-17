import { ApiError } from "#/lib/api-error";
import { validateDiscoveredUrl } from "./url.server";

/**
 * OAuth discovery for MCP servers, following the MCP authorization spec:
 * https://modelcontextprotocol.io/specification/draft/basic/authorization
 *
 * Flow:
 * 1. Probe the MCP endpoint with an unauthenticated `initialize` request to
 *    learn whether auth is required at all (401 + WWW-Authenticate).
 * 2. If a protected-resource metadata document (RFC 9728) is advertised, use
 *    its authorization server.
 * 3. Fetch the authorization server metadata (RFC 8414).
 * 4. Fall back to the MCP spec default endpoints (/authorize, /token,
 *    /register) on the server origin when no metadata document exists.
 */

export interface OAuthServerMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}

export interface McpDiscoveryResult {
  requiresAuth: boolean;
  metadata?: OAuthServerMetadata;
}

const PROBE_TIMEOUT_MS = 8_000;

export const MCP_PROTOCOL_VERSION = "2025-06-18";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchJson(url: string, fetchImpl: FetchLike): Promise<unknown> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

function parseMetadata(raw: unknown): OAuthServerMetadata | undefined {
  if (!isRecord(raw)) return undefined;
  const authorization = raw.authorization_endpoint;
  const token = raw.token_endpoint;
  if (typeof authorization !== "string" || typeof token !== "string") return undefined;

  return {
    authorizationEndpoint: validateDiscoveredUrl(authorization, "authorization endpoint"),
    tokenEndpoint: validateDiscoveredUrl(token, "token endpoint"),
    registrationEndpoint:
      typeof raw.registration_endpoint === "string"
        ? validateDiscoveredUrl(raw.registration_endpoint, "registration endpoint")
        : undefined,
  };
}

/** Extracts the resource_metadata URL from a RFC 9728 WWW-Authenticate header. */
function parseResourceMetadata(header: string | null): string | undefined {
  if (!header) return undefined;
  const match =
    /resource_metadata="([^"]+)"/i.exec(header) ?? /resource_metadata=([^,\s]+)/i.exec(header);
  return match?.[1];
}

/**
 * Sends an unauthenticated MCP `initialize` probe. Returns the response so the
 * caller can inspect the status code. Never throws on HTTP error statuses;
 * throws ApiError(502) only when the server cannot be reached at all.
 */
export async function probeMcpServer(
  serverUrl: string,
  fetchImpl: FetchLike = fetch,
  authHeader?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // MCP Streamable HTTP requires accepting both JSON and SSE responses.
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  if (authHeader) headers.authorization = authHeader;

  let response: Response;
  try {
    response = await fetchImpl(serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tendon-probe",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "tendon", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new ApiError(
      502,
      timedOut
        ? "The MCP server did not respond in time"
        : "Unable to reach the MCP server. Check the URL and try again.",
    );
  }

  return response;
}

export async function discoverMcpAuth(
  serverUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<McpDiscoveryResult> {
  const probe = await probeMcpServer(serverUrl, fetchImpl);

  if (probe.status !== 401 && probe.status !== 403) {
    // Any other response means the endpoint answered without requiring auth.
    // Drain the body so the connection can be reused, then stop here.
    await probe.body?.cancel();
    return { requiresAuth: false };
  }
  await probe.body?.cancel();

  const origin = new URL(serverUrl).origin;

  // RFC 9728: the server may point at a protected-resource metadata document.
  const resourceMetadataUrl = parseResourceMetadata(probe.headers.get("www-authenticate"));
  if (resourceMetadataUrl) {
    const resourceMetadata = await fetchJson(
      validateDiscoveredUrl(resourceMetadataUrl, "resource metadata URL"),
      fetchImpl,
    );
    const authorizationServers = isRecord(resourceMetadata)
      ? resourceMetadata.authorization_servers
      : undefined;
    const authorizationServer = Array.isArray(authorizationServers)
      ? authorizationServers.find((entry): entry is string => typeof entry === "string")
      : undefined;

    if (authorizationServer) {
      const issuer = new URL(validateDiscoveredUrl(authorizationServer, "authorization server"));
      const metadata = parseMetadata(
        await fetchJson(`${issuer.origin}/.well-known/oauth-authorization-server`, fetchImpl),
      );
      if (metadata) return { requiresAuth: true, metadata };
    }
  }

  // RFC 8414 metadata on the MCP server origin itself.
  const metadata = parseMetadata(
    await fetchJson(`${origin}/.well-known/oauth-authorization-server`, fetchImpl),
  );
  if (metadata) return { requiresAuth: true, metadata };

  // MCP spec fallback: default endpoints on the server origin.
  return {
    requiresAuth: true,
    metadata: {
      authorizationEndpoint: `${origin}/authorize`,
      tokenEndpoint: `${origin}/token`,
      registrationEndpoint: `${origin}/register`,
    },
  };
}
