/**
 * OAuth discovery for MCP servers, plus SSRF-safe outbound fetching.
 *
 * Discovery order (per the MCP authorization spec):
 *  1. `GET {serverOrigin}/.well-known/oauth-protected-resource` — exposes the
 *     resource's `authorization_servers`, descriptive metadata, and bearer
 *     method support.
 *  2. For each candidate authorization server, `GET {as}/.well-known/
 *     oauth-authorization-server` (RFC 8414) to resolve endpoints.
 *
 * When the protected-resource document is absent we fall back to assuming the
 * server itself publishes the authorization-server metadata at its origin.
 *
 * All redirects are followed manually and re-validated through
 * `validateMcpServerUrl` so a metadata response cannot redirect us to a private
 * address (SSRF). Errors are sanitized: upstream bodies and headers are never
 * echoed to the client or written to logs.
 */
import { ApiError } from "#/lib/api-error";
import { type AuthorizationServerMetadata, type ProtectedResourceMetadata } from "./oauth.server";
import { validateMcpServerUrl, validateRedirect, type ValidateUrlOptions } from "./url.server";

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8_000;

export interface DiscoveredServer {
  resource: ProtectedResourceMetadata;
  authorizationServer: AuthorizationServerMetadata;
  /** Origin used to resolve relative metadata endpoints. */
  serverOrigin: string;
}

interface SafeFetchJsonOptions extends ValidateUrlOptions {
  maxRedirects?: number;
  /** Optional Authorization bearer for protected requests. */
  bearer?: string;
}

async function fetchSafeJson(url: string, options: SafeFetchJsonOptions = {}): Promise<unknown> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let current = validateMcpServerUrl(url, options).href;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        },
      });
    } catch (err) {
      clearTimeout(timeout);
      const message =
        err instanceof DOMException && err.name === "AbortError"
          ? "MCP server took too long to respond"
          : "Unable to reach MCP server";
      // Never surface raw network error text (may include host/IP).
      throw new ApiError(502, message);
    }
    clearTimeout(timeout);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (hop === maxRedirects) throw new ApiError(502, "MCP server redirected too many times");
      // Re-validate the redirect target against the SSRF rules.
      const next = validateRedirect(location ?? "", current, options);
      current = next.href;
      continue;
    }

    if (!response.ok) {
      throw new ApiError(502, "MCP server rejected the discovery request");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new ApiError(502, "MCP server discovery response was not JSON");
    }
    try {
      return await response.json();
    } catch {
      throw new ApiError(502, "MCP server returned malformed discovery JSON");
    }
  }
  throw new ApiError(502, "MCP server redirected too many times");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Run OAuth discovery against `serverUrl`.
 * Throws an `ApiError` (4xx/5xx) with a sanitized message on any failure —
 * never leaking upstream response bodies or headers.
 */
export async function discover(
  serverUrl: string,
  options: ValidateUrlOptions = {},
): Promise<DiscoveredServer> {
  const base = validateMcpServerUrl(serverUrl, options);
  const serverOrigin = base.origin;

  // 1. Protected-resource metadata (optional; absence is tolerated for older
  //    MCP servers). Only 502 "upstream rejected discovery" errors are
  //    swallowed here; anything else (e.g. a 400 from a malformed URL) is
  //    thrown, since we cannot safely proceed.
  let protectedResource: ProtectedResourceMetadata = {};
  try {
    const resourceDoc = await fetchSafeJson(
      `${serverOrigin}/.well-known/oauth-protected-resource`,
      {
        ...options,
        maxRedirects: 1,
      },
    );
    const obj = asObject(resourceDoc);
    if (obj) {
      protectedResource = {
        resource: typeof obj.resource === "string" ? obj.resource : undefined,
        authorization_servers: Array.isArray(obj.authorization_servers)
          ? (obj.authorization_servers as string[]).filter((s) => typeof s === "string")
          : undefined,
        name: typeof obj.name === "string" ? obj.name.slice(0, 200) : undefined,
        description:
          typeof obj.description === "string" ? obj.description.slice(0, 400) : undefined,
        icon_uri:
          typeof obj.icon_uri === "string" && obj.icon_uri.startsWith("https://")
            ? obj.icon_uri.slice(0, 512)
            : undefined,
        bearer_methods_supported: Array.isArray(obj.bearer_methods_supported)
          ? (obj.bearer_methods_supported as string[])
          : undefined,
      };
    }
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 502)) throw err;
  }

  // 2. Authorization-server discovery.
  const candidateIssuers =
    protectedResource.authorization_servers && protectedResource.authorization_servers.length > 0
      ? protectedResource.authorization_servers.slice(0, 3)
      : [serverOrigin];

  let metadata: AuthorizationServerMetadata | null = null;
  let errors = 0;
  for (const issuer of candidateIssuers) {
    try {
      const doc = await fetchSafeJson(
        `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
        {
          ...options,
          maxRedirects: 1,
        },
      );
      const obj = asObject(doc);
      if (!obj) continue;
      metadata = {
        issuer: typeof obj.issuer === "string" ? obj.issuer : undefined,
        authorization_endpoint:
          typeof obj.authorization_endpoint === "string" ? obj.authorization_endpoint : undefined,
        token_endpoint: typeof obj.token_endpoint === "string" ? obj.token_endpoint : undefined,
        registration_endpoint:
          typeof obj.registration_endpoint === "string" ? obj.registration_endpoint : undefined,
        revocation_endpoint:
          typeof obj.revocation_endpoint === "string" ? obj.revocation_endpoint : undefined,
        scopes_supported: Array.isArray(obj.scopes_supported)
          ? (obj.scopes_supported as string[])
          : undefined,
        code_challenge_methods_supported: Array.isArray(obj.code_challenge_methods_supported)
          ? (obj.code_challenge_methods_supported as string[])
          : undefined,
      };
      if (metadata.authorization_endpoint && metadata.token_endpoint) break;
      metadata = null;
    } catch (err) {
      errors++;
      if (err instanceof ApiError && err.status !== 502) throw err;
    }
  }

  if (!metadata || !metadata.authorization_endpoint || !metadata.token_endpoint) {
    if (errors > 0) throw new ApiError(502, "MCP server does not expose a usable OAuth config");
    throw new ApiError(422, "MCP server does not expose a usable OAuth config");
  }

  return {
    resource: protectedResource,
    authorizationServer: metadata,
    serverOrigin,
  };
}

/**
 * Best-effort probe that the MCP server accepts an authenticated MCP initialize
 * request. Returns a sanitized status string. Never throws raw upstream text.
 */
export async function probeMcpServer(
  serverUrl: string,
  token: string,
  options: ValidateUrlOptions = {},
): Promise<{ ok: boolean; message: string; status: number }> {
  const base = validateMcpServerUrl(serverUrl, options).href;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(base, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "tendon-tanstack-template", version: "1.0.0" },
        },
      }),
    });
    clearTimeout(timeout);
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: "Authentication rejected by the MCP server",
        status: response.status,
      };
    }
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, message: "MCP server responded successfully", status: response.status };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      return { ok: false, message: "MCP server redirected unexpectedly", status: response.status };
    }
    return {
      ok: response.status < 400,
      message: `MCP server responded with ${response.status}`,
      status: response.status,
    };
  } catch (err) {
    clearTimeout(timeout);
    const message =
      err instanceof DOMException && err.name === "AbortError"
        ? "MCP server took too long to respond"
        : "Unable to reach MCP server";
    return { ok: false, message, status: 0 };
  }
}
