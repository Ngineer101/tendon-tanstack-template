import { ApiError } from "#/lib/api-error";
import { safeRedirectTarget, validateExternalUrl } from "./security";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export async function readBoundedText(response: Response, limit = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ApiError(502, "The MCP server returned an oversized response", {
      code: "upstream_response_too_large",
    });
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(502, "The MCP server returned an oversized response", {
          code: "upstream_response_too_large",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function readBoundedJson(response: Response) {
  const text = await readBoundedText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(502, "The MCP server returned invalid JSON", {
      code: "invalid_upstream_response",
    });
  }
}

export async function safeExternalFetch(
  input: string | URL,
  init: RequestInit = {},
  options: { redirects?: number; redirectOrigin?: string } = {},
): Promise<Response> {
  let target = validateExternalUrl(input.toString());
  const maximumRedirects = options.redirects ?? 0;

  for (let redirect = 0; ; redirect += 1) {
    let response: Response;
    try {
      response = await fetch(target, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError(502, "Unable to reach the MCP server", {
        code: "mcp_unreachable",
      });
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirect >= maximumRedirects) {
      throw new ApiError(502, "The MCP server returned an unexpected redirect", {
        code: "unexpected_redirect",
      });
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new ApiError(502, "The MCP server returned an invalid redirect", {
        code: "unsafe_redirect",
      });
    }
    const resolved = new URL(location, target);
    target = safeRedirectTarget(resolved.toString(), options.redirectOrigin ?? target.origin);
  }
}

export async function fetchJson(
  input: string | URL,
  init: RequestInit = {},
  options: { redirects?: number; redirectOrigin?: string } = {},
) {
  const response = await safeExternalFetch(input, init, options);
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(502, "The MCP server rejected a discovery request", {
      code: "oauth_discovery_failed",
    });
  }
  return readBoundedJson(response);
}
