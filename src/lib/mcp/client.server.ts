/**
 * MCP OAuth client operations: optional dynamic client registration (RFC 7591),
 * authorization-code -> token exchange (RFC 6749 §4.1.3), and refresh.
 *
 * All endpoints originate from validated discovery metadata and are
 * re-validated here against the SSRF rules before any request leaves the worker.
 * Token responses are parsed into a normalized `McpAuthData` shape whose JSON
 * is what gets encrypted at rest — never logged, never returned to the client.
 */
import { ApiError } from "#/lib/api-error";
import { validateMcpServerUrl, type ValidateUrlOptions } from "./url.server";

export interface McpAuthData {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number; // epoch ms
  scope?: string;
  /**
   * Client credentials issued by dynamic client registration. Required to
   * refresh tokens for confidential clients and to revoke on disconnect.
   */
  clientId?: string;
  clientSecret?: string;
  /** Authorization server metadata snapshot needed to refresh/revoke. */
  tokenEndpoint?: string;
  revocationEndpoint?: string;
}

interface SafePostOptions extends ValidateUrlOptions {
  /** Forms `application/x-www-form-urlencoded` body. */
  form: Record<string, string>;
  /** Optional Basic auth header value (already base64-encoded `id:secret`). */
  basicAuth?: string;
  timeoutMs?: number;
}

async function postForm(endpoint: string, opts: SafePostOptions): Promise<Record<string, unknown>> {
  const safe = validateMcpServerUrl(endpoint, { allowLoopbackHttp: opts.allowLoopbackHttp });
  const body = new URLSearchParams(opts.form).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  let response: Response;
  try {
    response = await fetch(safe.href, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...(opts.basicAuth ? { authorization: `Basic ${opts.basicAuth}` } : {}),
      },
      body,
    });
  } catch {
    clearTimeout(timeout);
    throw new ApiError(502, "Unable to contact the MCP authorization server");
  }
  clearTimeout(timeout);

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    throw new ApiError(502, "MCP authorization server returned an unsafe redirect");
  }

  if (!response.ok) {
    // RFC 6749 error responses have a `error` field; we surface it generically
    // without any upstream identifiers/tokens.
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    const errorCode = parsed && typeof parsed.error === "string" ? parsed.error : null;
    throw new ApiError(
      502,
      errorCode
        ? `MCP authorization error: ${errorCode}`
        : "MCP authorization server rejected the request",
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError(502, "MCP authorization server returned malformed JSON");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new ApiError(502, "MCP authorization server returned an invalid token response");
  }
  return json as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readExpiresIn(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Date.now() + n * 1000;
}

export interface RegisterClientResult {
  clientId: string;
  clientSecret?: string;
}

export async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
  scopes: string[],
  options: ValidateUrlOptions = {},
): Promise<RegisterClientResult | null> {
  try {
    const json = await postForm(registrationEndpoint, {
      allowLoopbackHttp: options.allowLoopbackHttp,
      form: {
        redirect_uris: redirectUri,
        token_endpoint_auth_method: "none",
        grant_types: "authorization_code refresh_token",
        response_types: "code",
        scope: scopes.join(" "),
      },
    });
    const clientId = readString(json.client_id);
    if (!clientId) return null;
    return {
      clientId,
      clientSecret: readString(json.client_secret),
    };
  } catch (err) {
    // DCR may be unsupported; callers fall back to user-supplied client_id.
    if (err instanceof ApiError && err.status === 502) return null;
    throw err;
  }
}

export async function exchangeCodeForTokens(params: {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  options: ValidateUrlOptions;
}): Promise<McpAuthData> {
  const basicAuth = params.clientSecret
    ? btoa(`${params.clientId}:${params.clientSecret}`)
    : undefined;
  const json = await postForm(params.tokenEndpoint, {
    allowLoopbackHttp: params.options.allowLoopbackHttp,
    basicAuth,
    form: {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
      code_verifier: params.codeVerifier,
    },
  });

  const accessToken = readString(json.access_token);
  if (!accessToken) throw new ApiError(502, "MCP token response is missing access_token");
  return {
    accessToken,
    refreshToken: readString(json.refresh_token),
    tokenType: readString(json.token_type),
    expiresAt: readExpiresIn(json.expires_in),
    scope: readString(json.scope),
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    tokenEndpoint: params.tokenEndpoint,
    revocationEndpoint: undefined,
  };
}

export async function revokeToken(params: {
  revocationEndpoint: string;
  token: string;
  clientId?: string;
  clientSecret?: string;
  options: ValidateUrlOptions;
}): Promise<void> {
  try {
    await postForm(params.revocationEndpoint, {
      allowLoopbackHttp: params.options.allowLoopbackHttp,
      basicAuth:
        params.clientSecret && params.clientId
          ? btoa(`${params.clientId}:${params.clientSecret}`)
          : undefined,
      form: {
        token: params.token,
        token_type_hint: "access_token",
        ...(params.clientId ? { client_id: params.clientId } : {}),
        ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
      },
    });
  } catch {
    // Best-effort: revocation failures must not block disconnect.
  }
}
