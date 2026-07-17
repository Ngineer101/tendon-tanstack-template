import { ApiError } from "#/lib/api-error";
import {
  assertSafeOutboundUrl,
  base64UrlEncode,
  MCP_PROTOCOL_VERSION,
  normalizeMcpServerUrl,
  readBoundedJson,
  safeOutboundFetch,
  type FetchLike,
  type ResolveHostname,
} from "./security.server";

export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  resource: string;
}

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

interface OAuthDependencies {
  fetcher?: FetchLike;
  resolveHostname?: ResolveHostname;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function parseStringArray(value: unknown, label: string, required = false) {
  if (value === undefined && !required) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new ApiError(502, `OAuth discovery returned invalid ${label}`);
  }
  return unique(value);
}

function parseResourceMetadata(value: unknown, serverUrl: string): ProtectedResourceMetadata {
  if (!value || typeof value !== "object") {
    throw new ApiError(502, "MCP protected resource metadata was invalid");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.resource !== "string") {
    throw new ApiError(502, "MCP protected resource metadata did not identify its resource");
  }

  const resource = normalizeMcpServerUrl(body.resource);
  if (resource !== serverUrl) {
    throw new ApiError(502, "MCP protected resource metadata did not match the server URL");
  }

  return {
    resource,
    authorization_servers: parseStringArray(
      body.authorization_servers,
      "authorization servers",
      true,
    )!,
    scopes_supported: parseStringArray(body.scopes_supported, "protected resource scopes"),
  };
}

function parseAuthorizationMetadata(value: unknown, expectedIssuer: string, resource: string) {
  if (!value || typeof value !== "object") {
    throw new ApiError(502, "OAuth authorization server metadata was invalid");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.issuer !== "string") {
    throw new ApiError(502, "OAuth authorization server metadata did not include an issuer");
  }

  const issuer = normalizeMcpServerUrl(body.issuer);
  if (issuer !== expectedIssuer) {
    throw new ApiError(502, "OAuth issuer did not match the discovered authorization server");
  }
  if (typeof body.authorization_endpoint !== "string" || typeof body.token_endpoint !== "string") {
    throw new ApiError(502, "OAuth discovery did not include the required endpoints");
  }

  const methods = parseStringArray(
    body.token_endpoint_auth_methods_supported,
    "token authentication methods",
  );
  const challenges = parseStringArray(
    body.code_challenge_methods_supported,
    "PKCE challenge methods",
  );
  if (challenges && !challenges.includes("S256")) {
    throw new ApiError(502, "The OAuth server does not support secure PKCE");
  }

  return {
    issuer,
    authorization_endpoint: normalizeMcpServerUrl(body.authorization_endpoint),
    token_endpoint: normalizeMcpServerUrl(body.token_endpoint),
    scopes_supported: parseStringArray(body.scopes_supported, "authorization server scopes"),
    token_endpoint_auth_methods_supported: methods,
    code_challenge_methods_supported: challenges,
    resource,
  } satisfies OAuthMetadata;
}

function extractResourceMetadataUrl(header: string | null) {
  if (!header) return undefined;
  const quoted = /(?:^|[,\s])resource_metadata\s*=\s*"([^"]+)"/i.exec(header)?.[1];
  if (quoted) return quoted;
  return /(?:^|[,\s])resource_metadata\s*=\s*([^,\s]+)/i.exec(header)?.[1];
}

function protectedResourceUrls(serverUrl: string) {
  const server = new URL(serverUrl);
  const path = server.pathname === "/" ? "" : server.pathname.replace(/\/$/, "");
  return unique([
    new URL(`/.well-known/oauth-protected-resource${path}`, server.origin).toString(),
    new URL("/.well-known/oauth-protected-resource", server.origin).toString(),
  ]);
}

function authorizationMetadataUrls(issuerValue: string) {
  const issuer = new URL(issuerValue);
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const urls = [
    new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin).toString(),
    new URL(`/.well-known/openid-configuration${path}`, issuer.origin).toString(),
  ];
  if (path)
    urls.push(new URL(`${path}/.well-known/openid-configuration`, issuer.origin).toString());
  return unique(urls);
}

async function fetchMetadata(url: string, label: string, dependencies: OAuthDependencies) {
  const response = await safeOutboundFetch(
    url,
    { headers: { accept: "application/json", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } },
    dependencies,
  );
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ApiError(502, `${label} redirects are not allowed`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(502, `${label} failed`, { status: response.status });
  }
  return readBoundedJson(response);
}

async function discoverProtectedResource(serverUrl: string, dependencies: OAuthDependencies) {
  const urls: string[] = [];
  try {
    const response = await safeOutboundFetch(
      serverUrl,
      {
        method: "GET",
        headers: {
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        },
      },
      dependencies,
    );
    const advertised = extractResourceMetadataUrl(response.headers.get("www-authenticate"));
    await response.body?.cancel();
    if (advertised) urls.push(advertised);
  } catch {
    // Well-known metadata remains the standards-defined fallback.
  }
  urls.push(...protectedResourceUrls(serverUrl));

  for (const url of unique(urls)) {
    try {
      const safeUrl = await assertSafeOutboundUrl(url, dependencies.resolveHostname);
      return parseResourceMetadata(
        await fetchMetadata(safeUrl, "MCP protected resource discovery", dependencies),
        serverUrl,
      );
    } catch {
      // Continue through the prescribed discovery fallbacks.
    }
  }
  throw new ApiError(502, "Unable to discover OAuth for this MCP server");
}

export async function discoverOAuthMetadata(value: string, dependencies: OAuthDependencies = {}) {
  const serverUrl = await assertSafeOutboundUrl(value, dependencies.resolveHostname);
  const resourceMetadata = await discoverProtectedResource(serverUrl, dependencies);
  const authorizationServer = await assertSafeOutboundUrl(
    resourceMetadata.authorization_servers[0],
    dependencies.resolveHostname,
  );

  for (const metadataUrl of authorizationMetadataUrls(authorizationServer)) {
    try {
      const metadata = parseAuthorizationMetadata(
        await fetchMetadata(metadataUrl, "OAuth authorization server discovery", dependencies),
        authorizationServer,
        resourceMetadata.resource,
      );
      await Promise.all([
        assertSafeOutboundUrl(metadata.authorization_endpoint, dependencies.resolveHostname),
        assertSafeOutboundUrl(metadata.token_endpoint, dependencies.resolveHostname),
      ]);
      return {
        serverUrl,
        metadata: {
          ...metadata,
          scopes_supported: resourceMetadata.scopes_supported ?? metadata.scopes_supported,
        },
      };
    } catch {
      // Continue through RFC 8414 and OpenID Connect discovery fallbacks.
    }
  }
  throw new ApiError(502, "Unable to discover the MCP authorization server");
}

export async function createPkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export function buildAuthorizationUrl(options: {
  metadata: OAuthMetadata;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string;
}) {
  const authorizationUrl = new URL(options.metadata.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", options.clientId);
  authorizationUrl.searchParams.set("redirect_uri", options.redirectUri);
  authorizationUrl.searchParams.set("state", options.state);
  authorizationUrl.searchParams.set("code_challenge", options.codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("resource", options.metadata.resource);
  if (options.scopes) authorizationUrl.searchParams.set("scope", options.scopes);
  return authorizationUrl.toString();
}

export function selectOAuthScopes(metadata: OAuthMetadata, requested?: string) {
  const explicit = requested?.trim().split(/\s+/).filter(Boolean);
  const scopes = explicit?.length ? unique(explicit) : metadata.scopes_supported;
  if (!scopes?.length) return undefined;
  if (
    scopes.join(" ").length > 500 ||
    scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))
  ) {
    throw new ApiError(400, "OAuth scopes contain unsupported characters or are too long");
  }
  return scopes.join(" ");
}

export function selectTokenAuthMethod(metadata: OAuthMetadata, hasClientSecret: boolean) {
  const supported = metadata.token_endpoint_auth_methods_supported;
  if (!supported?.length) return hasClientSecret ? "client_secret_basic" : "none";
  if (hasClientSecret && supported.includes("client_secret_basic")) return "client_secret_basic";
  if (hasClientSecret && supported.includes("client_secret_post")) return "client_secret_post";
  if (supported.includes("none")) return "none";
  throw new ApiError(500, "OAuth client authentication is not configured for this MCP server");
}
