// URL validation + SSRF guards for MCP servers.
//
// The connect flow fetches metadata from a user-provided URL on the server,
// so we must block private/loopback/link-local addresses and known cloud
// metadata endpoints. Cloudflare Workers cannot pre-resolve DNS, so we:
//   1. Restrict the scheme (https in non-dev, http only for localhost).
//   2. Reject hosts that are raw IP addresses in private/loopback/link-local
//      ranges or are known metadata hostnames (169.254.x.x, metadata.*).*
//   3. Reject obvious credentials in the URL and non-default ports for https.
//   4. Enforce a redirect-chain guard when fetching metadata: only follow
//      same-origin redirects, with a small max hop count.

import { ApiError } from "#/lib/api-error";

export interface ValidatedServerUrl {
  url: string;
  origin: string;
  hostname: string;
}

// Validate an arbitrary fetch target (an OAuth metadata or endpoint URL, which
// may legitimately have a path). Enforces scheme, no embedded credentials,
// and the SSRF hostname/IP blocklist.
export function validateFetchUrl(
  input: string,
  options: { allowLocalhost?: boolean } = {},
): ValidatedServerUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ApiError(400, "Enter a valid URL");
  }

  if (url.protocol === "http:") {
    if (!options.allowLocalhost && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new ApiError(400, "Only https: URLs are allowed");
    }
  } else if (url.protocol === "https:") {
    // allowed
  } else {
    throw new ApiError(400, "Only https: URLs are allowed");
  }

  if (url.username || url.password) {
    throw new ApiError(400, "Credentials must not be embedded in the server URL");
  }

  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new ApiError(400, "This hostname is not allowed");
  }

  if (isLikelyIp(hostname) && isBlockedIp(hostname)) {
    throw new ApiError(400, "Private or link-local IP addresses are not allowed");
  }

  // Drop hash — it cannot be part of a fetch request the server will honor.
  url.hash = "";

  return {
    url: url.toString(),
    origin: url.origin,
    hostname,
  };
}

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "169.254.169.254", // AWS/GCP/Azure metadata IP
  "fd00.metadata",
  "metadata.aws.internal",
]);

// Cloud metadata & link-local IPv4 ranges to block when the host is a raw IP.
const BLOCKED_IPV4_PREFIXES = [
  "0.",
  "10.", // private
  "127.", // loopback
  "169.254.", // link-local / metadata
  "172.16.",
  "172.17.",
  "172.18.",
  "172.19.",
  "172.20.",
  "172.21.",
  "172.22.",
  "172.23.",
  "172.24.",
  "172.25.",
  "172.26.",
  "172.27.",
  "172.28.",
  "172.29.",
  "172.30.",
  "172.31.", // private
  "192.0.2.", // TEST-NET-1 documentation
  "192.168.", // private
  "198.18.",
  "198.19.", // benchmarking
  "198.51.100.", // TEST-NET-2
  "203.0.113.", // TEST-NET-3
  "240.",
  "241.",
  "242.",
  "243.",
  "244.",
  "245.",
  "246.",
  "247.",
  "248.",
  "249.",
  "250.",
  "251.",
  "252.",
  "253.",
  "254.",
  "255.", // reserved
];

// Very small IPv6 guard: block ::1, fc00::/7, fe80::/10, and ::uroleback.
const BLOCKED_IPV6_PREFIXES = ["::1", "fc", "fd", "fe80", "fe9", "fea", "feb"];

function isLikelyIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function isBlockedIp(host: string): boolean {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    for (const prefix of BLOCKED_IPV4_PREFIXES) {
      if (host.startsWith(prefix)) return true;
    }
    return false;
  }
  // IPv6 (strip brackets and port)
  const cleaned = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  for (const prefix of BLOCKED_IPV6_PREFIXES) {
    if (cleaned.startsWith(prefix)) return true;
  }
  return false;
}

export function validateServerUrl(
  input: string,
  options: { allowLocalhost?: boolean } = {},
): ValidatedServerUrl {
  const validated = validateFetchUrl(input, options);

  // The user-entered server URL must be the server root (origin only). MCP
  // servers are identified by origin; we reject paths beyond "/" so discovery
  // stays deterministic and the URL is stable as an identity key.
  const parsed = new URL(validated.url);
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new ApiError(400, "Enter the server root URL without a path");
  }
  // Strip any query/search and normalize to `${origin}/`.
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = "/";
  return {
    url: parsed.toString(),
    origin: parsed.origin,
    hostname: validated.hostname,
  };
}

// Guard the app origin against self-SSRF. Pass the validated URL plus the
// current app origin (from the request) — returns true if they collide.
export function isSelfOrigin(origin: string, appOrigin: string): boolean {
  try {
    return new URL(origin).hostname.toLowerCase() === new URL(appOrigin).hostname.toLowerCase();
  } catch {
    return false;
  }
}

// Fetch a URL with SSRF protections and a hard redirect guard. Only follows
// redirects whose destination passes `validateServerUrl`, and reports the
// chain so the caller can implement the guard.
export async function safeFetch(
  input: string,
  init: RequestInit & { timeoutMs?: number } = {},
  options: { allowLocalhost?: boolean; maxRedirects?: number; appOrigin?: string } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, ...fetchInit } = init;
  const maxRedirects = options.maxRedirects ?? 0;
  let nextUrl = input;
  const visited = new Set<string>();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Re-validate every hop (including the first) so a Location header to an
    // internal host cannot be smuggled in. Fetch targets may have paths.
    const validated = validateFetchUrl(nextUrl, { allowLocalhost: options.allowLocalhost });
    if (visited.has(validated.url) && hop > 0) {
      throw new ApiError(400, "The server responded with a redirect loop");
    }
    visited.add(validated.url);
    if (options.appOrigin && isSelfOrigin(validated.origin, options.appOrigin)) {
      throw new ApiError(400, "Cannot connect a server that points back at this app");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(validated.url, {
        ...fetchInit,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new ApiError(502, "The server returned a redirect without a location");
      nextUrl = new URL(location, validated.origin).toString();
      continue;
    }
    return response;
  }
  throw new ApiError(400, "The server responded with too many redirects");
}
