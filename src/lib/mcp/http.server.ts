import { ApiError } from "#/lib/api-error";
import { MCP_FETCH_TIMEOUT_MS, MCP_MAX_REDIRECTS } from "./config.server";
import { assertSafeRedirectTarget } from "./url";

/**
 * fetch() wrapper for talking to MCP servers and their authorization servers.
 *
 * - Enforces a hard timeout so a hanging server cannot stall the worker.
 * - Follows redirects manually and re-validates every hop against the SSRF
 *   policy instead of trusting the remote server.
 * - Never logs response bodies, which may contain credentials.
 */
export async function safeFetch(
  url: string | URL,
  init: RequestInit = {},
  options: { maxRedirects?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? MCP_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? MCP_FETCH_TIMEOUT_MS;

  let current: string | URL = url;
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, "Unable to reach the MCP server");
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hop >= maxRedirects) {
        throw new ApiError(502, "MCP server returned too many redirects");
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new ApiError(502, "MCP server returned an invalid redirect");
      }
      current = assertSafeRedirectTarget(next.toString());
      // Redirects always drop the request body and authorization material.
      const { headers, ...rest } = init;
      const safeHeaders = new Headers(headers);
      safeHeaders.delete("authorization");
      init = { ...rest, headers: safeHeaders };
      continue;
    }

    return response;
  }
}

/**
 * Reads a response body with a size cap. Bodies are never logged because they
 * may contain credentials.
 */
export async function readTextSafely(
  response: Response,
  maxBytes = 64 * 1024,
): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Reads a JSON response with a size cap. Returns null when the body is not
 * valid JSON. Bodies are never logged because they may contain tokens.
 */
export async function readJsonSafely(response: Response, maxBytes = 64 * 1024): Promise<unknown> {
  const text = await readTextSafely(response, maxBytes);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
