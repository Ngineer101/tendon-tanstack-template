import { ApiError } from "#/lib/api-error";

// SSRF protection for user-supplied MCP server URLs and any OAuth endpoints we
// discover from them. Everything the worker fetches on behalf of a user must
// pass through assertSafeExternalUrl/safeFetch.
//
// Known residual risk (documented in docs/mcp-server-connections.md): Workers
// cannot resolve DNS ahead of fetching, so a public hostname that resolves to a
// private address (DNS rebinding) cannot be detected here. Cloudflare's egress
// network does not sit inside the deployment's private network, which limits
// the blast radius of that class of attack.

export interface UrlSecurityOptions {
  // Development escape hatch (MCP_ALLOW_INSECURE_LOCALHOST=true) that allows
  // plain-HTTP loopback URLs so local MCP servers can be tested.
  allowInsecureLocalhost?: boolean;
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".in-addr.arpa"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);

function parseIpv4(hostname: string): number[] | null {
  // WHATWG URL parsing already normalises decimal/octal/hex IPv4 forms
  // (e.g. http://2130706433 -> 127.0.0.1), so a dotted-quad check suffices.
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isPrivateOrReservedIpv4([a, b]: number[]) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isLoopbackHost(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const ipv4 = parseIpv4(hostname);
  return ipv4 !== null && ipv4[0] === 127;
}

export function assertSafeExternalUrl(raw: string | URL, options: UrlSecurityOptions = {}): URL {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new ApiError(400, "Enter a valid URL, e.g. https://mcp.example.com/mcp");
  }

  if (url.username || url.password) {
    throw new ApiError(400, "URLs must not embed credentials");
  }

  const hostname = url.hostname.toLowerCase();

  if (options.allowInsecureLocalhost && isLoopbackHost(hostname)) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ApiError(400, "Only HTTP(S) URLs are supported");
    }
    return url;
  }

  if (url.protocol !== "https:") {
    throw new ApiError(400, "Only HTTPS URLs are supported");
  }

  if (BLOCKED_HOSTS.has(hostname) || BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw new ApiError(400, "This host is not allowed");
  }

  if (hostname.startsWith("[")) {
    // IPv6 literals are rejected wholesale rather than range-checked.
    throw new ApiError(400, "IPv6 literal addresses are not supported; use a hostname");
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4 && isPrivateOrReservedIpv4(ipv4)) {
    throw new ApiError(400, "Private and reserved network addresses are not allowed");
  }

  return url;
}

export interface SafeFetchOptions extends UrlSecurityOptions {
  timeoutMs?: number;
}

// fetch() that re-validates the target and refuses to follow redirects, so a
// vetted URL cannot bounce a credentialed request to an arbitrary host.
export async function safeFetch(
  raw: string | URL,
  init: RequestInit,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const url = assertSafeExternalUrl(raw, options);
  const response = await fetch(url.toString(), {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });

  if (response.status >= 300 && response.status < 400) {
    throw new ApiError(502, "The server responded with a redirect, which is not allowed");
  }

  return response;
}
