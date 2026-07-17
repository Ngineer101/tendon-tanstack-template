import { ApiError } from "#/lib/api-error";
import { randomBase64Url, sha256Base64Url } from "./crypto.server";
import { fetchJson, readBoundedJson, safeExternalFetch } from "./network.server";
import {
  parseWwwAuthenticateMetadata,
  parseWwwAuthenticateScope,
  safeRedirectTarget,
  validateExternalUrl,
} from "./security";

const MCP_PROTOCOL_VERSION = "2025-11-25";

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
}

export interface OAuthPreparation {
  authorizationUrl: string;
  state: string;
  stateHash: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
  redirectUri: string;
  resource: string;
}

export type McpDiscovery =
  | { authType: "none" }
  | {
      authType: "oauth";
      resource: string;
      scopes: string[];
      metadata: AuthorizationServerMetadata;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new ApiError(502, "OAuth discovery metadata is incomplete", {
      code: "oauth_discovery_incomplete",
    });
  }
  return value;
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function protectedResourceCandidates(serverUrl: URL) {
  const path = serverUrl.pathname === "/" ? "" : serverUrl.pathname.replace(/\/$/, "");
  return [
    new URL(`/.well-known/oauth-protected-resource${path}`, serverUrl.origin),
    new URL("/.well-known/oauth-protected-resource", serverUrl.origin),
  ];
}

function authorizationMetadataCandidates(issuer: URL) {
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  return path
    ? [
        new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
        new URL(`/.well-known/openid-configuration${path}`, issuer.origin),
        new URL(`${path}/.well-known/openid-configuration`, issuer.origin),
      ]
    : [
        new URL("/.well-known/oauth-authorization-server", issuer.origin),
        new URL("/.well-known/openid-configuration", issuer.origin),
      ];
}

async function firstJson(candidates: URL[], label: string) {
  for (const candidate of candidates) {
    try {
      return await fetchJson(
        candidate,
        { headers: { accept: "application/json" } },
        {
          redirects: 1,
          redirectOrigin: candidate.origin,
        },
      );
    } catch (error) {
      if (candidate === candidates.at(-1)) throw error;
    }
  }
  throw new ApiError(502, `Unable to discover ${label}`, { code: "oauth_discovery_failed" });
}

export async function discoverMcpOAuth(serverUrl: string): Promise<McpDiscovery> {
  const server = validateExternalUrl(serverUrl);
  const probe = await safeExternalFetch(
    server,
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "connection-check",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "Tendon", version: "1.0.0" },
        },
      }),
    },
    { redirects: 1, redirectOrigin: server.origin },
  );

  if (probe.ok) {
    await probe.body?.cancel();
    return { authType: "none" };
  }

  const authenticateChallenge = probe.headers.get("www-authenticate");
  const advertisedMetadata = parseWwwAuthenticateMetadata(authenticateChallenge);
  const challengedScopes = parseWwwAuthenticateScope(authenticateChallenge);
  await probe.body?.cancel();
  const resourceCandidates = advertisedMetadata
    ? [safeRedirectTarget(new URL(advertisedMetadata, server).toString(), server.origin)]
    : protectedResourceCandidates(server);
  const resourceDocument = await firstJson(resourceCandidates, "MCP authorization");
  if (!isRecord(resourceDocument)) {
    throw new ApiError(502, "OAuth protected resource metadata is invalid", {
      code: "oauth_discovery_invalid",
    });
  }

  const resource = requireString(resourceDocument, "resource");
  const resourceUrl = validateExternalUrl(resource, "OAuth resource");
  if (resourceUrl.origin !== server.origin) {
    throw new ApiError(502, "OAuth resource metadata does not match the MCP server", {
      code: "oauth_resource_mismatch",
    });
  }
  const authorizationServers = stringArray(resourceDocument.authorization_servers);
  if (!authorizationServers?.length) {
    throw new ApiError(502, "The MCP server did not advertise an authorization server", {
      code: "oauth_discovery_incomplete",
    });
  }

  const issuer = validateExternalUrl(authorizationServers[0]!, "OAuth issuer");
  const authorizationDocument = await firstJson(
    authorizationMetadataCandidates(issuer),
    "OAuth server metadata",
  );
  if (!isRecord(authorizationDocument)) {
    throw new ApiError(502, "OAuth server metadata is invalid", {
      code: "oauth_discovery_invalid",
    });
  }

  const discoveredIssuer = validateExternalUrl(
    requireString(authorizationDocument, "issuer"),
    "OAuth issuer",
  );
  if (discoveredIssuer.toString().replace(/\/$/, "") !== issuer.toString().replace(/\/$/, "")) {
    throw new ApiError(502, "OAuth issuer metadata did not match the advertised issuer", {
      code: "oauth_issuer_mismatch",
    });
  }
  const methods = stringArray(authorizationDocument.code_challenge_methods_supported);
  if (!methods?.includes("S256")) {
    throw new ApiError(502, "The OAuth server does not advertise required PKCE support", {
      code: "oauth_pkce_unsupported",
    });
  }

  const metadata: AuthorizationServerMetadata = {
    issuer: discoveredIssuer.toString(),
    authorization_endpoint: validateExternalUrl(
      requireString(authorizationDocument, "authorization_endpoint"),
      "OAuth authorization endpoint",
    ).toString(),
    token_endpoint: validateExternalUrl(
      requireString(authorizationDocument, "token_endpoint"),
      "OAuth token endpoint",
    ).toString(),
    registration_endpoint:
      typeof authorizationDocument.registration_endpoint === "string"
        ? validateExternalUrl(
            authorizationDocument.registration_endpoint,
            "OAuth registration endpoint",
          ).toString()
        : undefined,
    code_challenge_methods_supported: methods,
    token_endpoint_auth_methods_supported: stringArray(
      authorizationDocument.token_endpoint_auth_methods_supported,
    ),
    client_id_metadata_document_supported:
      authorizationDocument.client_id_metadata_document_supported === true,
  };

  return {
    authType: "oauth",
    resource: resourceUrl.toString(),
    scopes: challengedScopes ?? stringArray(resourceDocument.scopes_supported) ?? [],
    metadata,
  };
}

function selectTokenAuthMethod(
  metadata: AuthorizationServerMetadata,
  hasClientSecret: boolean,
): "none" | "client_secret_basic" | "client_secret_post" {
  const methods = metadata.token_endpoint_auth_methods_supported ?? [];
  if (!hasClientSecret && (methods.length === 0 || methods.includes("none"))) return "none";
  if (hasClientSecret && methods.includes("client_secret_basic")) return "client_secret_basic";
  if (hasClientSecret && methods.includes("client_secret_post")) return "client_secret_post";
  throw new ApiError(502, "The OAuth server requires an unsupported client authentication method", {
    code: "oauth_client_auth_unsupported",
  });
}

async function registerClient(
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
): Promise<{
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "none" | "client_secret_basic" | "client_secret_post";
}> {
  if (!metadata.registration_endpoint) {
    throw new ApiError(
      422,
      "This MCP server does not support automatic OAuth client registration",
      { code: "oauth_registration_unsupported" },
    );
  }
  const response = await safeExternalFetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Tendon MCP Client",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(502, "OAuth client registration was rejected", {
      code: "oauth_registration_failed",
    });
  }
  const document = await readBoundedJson(response);
  if (!isRecord(document) || typeof document.client_id !== "string") {
    throw new ApiError(502, "OAuth client registration returned invalid data", {
      code: "oauth_registration_failed",
    });
  }
  return {
    clientId: document.client_id,
    clientSecret: typeof document.client_secret === "string" ? document.client_secret : undefined,
    tokenEndpointAuthMethod:
      document.token_endpoint_auth_method === "client_secret_basic" ||
      document.token_endpoint_auth_method === "client_secret_post" ||
      document.token_endpoint_auth_method === "none"
        ? document.token_endpoint_auth_method
        : undefined,
  };
}

export async function prepareOAuth(
  discovery: Extract<McpDiscovery, { authType: "oauth" }>,
  appOrigin: string,
): Promise<OAuthPreparation> {
  const redirectUri = `${appOrigin}/api/mcp/oauth/callback`;
  let clientId: string;
  let clientSecret: string | undefined;
  let registeredAuthMethod: "none" | "client_secret_basic" | "client_secret_post" | undefined;

  if (discovery.metadata.client_id_metadata_document_supported) {
    clientId = `${appOrigin}/api/mcp/oauth/client-metadata`;
  } else {
    const registration = await registerClient(discovery.metadata, redirectUri);
    clientId = registration.clientId;
    clientSecret = registration.clientSecret;
    registeredAuthMethod = registration.tokenEndpointAuthMethod;
  }

  const tokenEndpointAuthMethod =
    registeredAuthMethod ?? selectTokenAuthMethod(discovery.metadata, !!clientSecret);
  const codeVerifier = randomBase64Url(64);
  const state = randomBase64Url(32);
  const [stateHash, codeChallenge] = await Promise.all([
    sha256Base64Url(state),
    sha256Base64Url(codeVerifier),
  ]);
  const authorizationUrl = safeRedirectTarget(discovery.metadata.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("resource", discovery.resource);
  if (discovery.scopes.length) {
    authorizationUrl.searchParams.set("scope", discovery.scopes.join(" "));
  }

  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
    stateHash,
    codeVerifier,
    clientId,
    clientSecret,
    tokenEndpoint: discovery.metadata.token_endpoint,
    tokenEndpointAuthMethod,
    redirectUri,
    resource: discovery.resource,
  };
}

export async function requestToken(
  input: {
    tokenEndpoint: string;
    tokenEndpointAuthMethod: "none" | "client_secret_basic" | "client_secret_post";
    clientId: string;
    clientSecret?: string;
    resource: string;
  },
  grant:
    | { type: "authorization_code"; code: string; codeVerifier: string; redirectUri: string }
    | { type: "refresh_token"; refreshToken: string },
) {
  const body = new URLSearchParams({
    grant_type: grant.type,
    client_id: input.clientId,
    resource: input.resource,
  });
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
  if (grant.type === "authorization_code") {
    body.set("code", grant.code);
    body.set("code_verifier", grant.codeVerifier);
    body.set("redirect_uri", grant.redirectUri);
  } else {
    body.set("refresh_token", grant.refreshToken);
  }
  if (input.tokenEndpointAuthMethod === "client_secret_basic" && input.clientSecret) {
    const formEncode = (value: string) =>
      new URLSearchParams({ value }).toString().slice("value=".length);
    headers.set(
      "authorization",
      `Basic ${btoa(`${formEncode(input.clientId)}:${formEncode(input.clientSecret)}`)}`,
    );
  } else if (input.tokenEndpointAuthMethod === "client_secret_post" && input.clientSecret) {
    body.set("client_secret", input.clientSecret);
  }

  const response = await safeExternalFetch(input.tokenEndpoint, {
    method: "POST",
    headers,
    body,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(502, "The OAuth server rejected the token request", {
      code: "oauth_token_exchange_failed",
    });
  }
  const document = await readBoundedJson(response);
  if (!isRecord(document) || typeof document.access_token !== "string") {
    throw new ApiError(502, "The OAuth server returned an invalid token response", {
      code: "oauth_token_response_invalid",
    });
  }
  const tokenType = typeof document.token_type === "string" ? document.token_type : "Bearer";
  if (tokenType.toLowerCase() !== "bearer") {
    throw new ApiError(502, "The MCP server returned an unsupported token type", {
      code: "oauth_token_type_unsupported",
    });
  }
  return {
    accessToken: document.access_token,
    refreshToken: typeof document.refresh_token === "string" ? document.refresh_token : undefined,
    scope: typeof document.scope === "string" ? document.scope : undefined,
    expiresAt:
      typeof document.expires_in === "number" && document.expires_in > 0
        ? Date.now() + document.expires_in * 1_000
        : undefined,
  };
}
