/**
 * URL validation and SSRF protection for outbound requests to user-supplied
 * MCP servers.
 *
 * Security model:
 *  - Schemes restricted to `https` in production. `http` is only permitted for
 *    loopback hosts so local development works.
 *  - Hosts that resolve to / are written as private/internal addresses are
 *    rejected. Resolution happens via DNS lookup on the worker; here we also
 *    statically reject literal private/loopback/link-local hosts except
 *    loopback, which is special-cased.
 *  - Redirects are re-validated on each hop (see `discover` / `fetchSafe`).
 *  - Credentials embedded in URLs are forbidden — stripping them silently would
 *    hide footguns, so we reject instead.
 */
import { ApiError } from "#/lib/api-error";

function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "::1" ||
    lower === "127.0.0.1" ||
    lower.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(lower)
  );
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

// [start, end] inclusive ranges as uint32.
const PRIVATE_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10 (CGNAT)
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 (loopback, also blocked non-loopback form)
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 (link-local)
  [0xac100000, 0xac15ffff], // 172.16.0.0/12
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24 (TEST-NET-1)
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 (benchmark)
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24 (TEST-NET-2)
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 (TEST-NET-3)
];

export function isPrivateHost(host: string): boolean {
  if (isLoopbackHost(host)) return false;
  const stripped = host.replace(/^\[|\]$/g, "").toLowerCase();
  // IPv6 private / unique-local / link-local / unspecified / v4-mapped.
  if (
    stripped.startsWith("fc") ||
    stripped.startsWith("fd") ||
    stripped.startsWith("fe8") ||
    stripped.startsWith("fe9") ||
    stripped.startsWith("fea") ||
    stripped.startsWith("feb") ||
    stripped === "::" ||
    stripped.startsWith("::ffff:")
  ) {
    return true;
  }
  const ip = stripped.split(":")[0];
  const v = ipv4ToInt(ip);
  if (v !== null) {
    return PRIVATE_IPV4_RANGES.some(([a, b]) => v >= a && v <= b);
  }
  return false;
}

export interface SafeUrl {
  href: string;
  origin: string;
  host: string;
}

export interface ValidateUrlOptions {
  /** Allow `http:` for loopback hosts (dev). Defaults to false (https-only). */
  allowLoopbackHttp?: boolean;
}

export function validateMcpServerUrl(raw: string, options: ValidateUrlOptions = {}): SafeUrl {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    throw new ApiError(400, "Server URL is required");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "Server URL must be a valid URL");
  }

  if (url.username || url.password) {
    throw new ApiError(400, "Server URL must not contain credentials");
  }

  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol === "http:" && (!options.allowLoopbackHttp || !loopback)) {
    throw new ApiError(400, "Server URL must use https");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ApiError(400, "Unsupported URL scheme");
  }

  if (isPrivateHost(url.hostname)) {
    throw new ApiError(422, "Server URL must be a publicly reachable address");
  }

  // Normalize: drop hash and trailing stuff we don't act on.
  url.hash = "";
  return { href: url.href, origin: url.origin, host: url.host };
}

/**
 * Re-validate a redirect target before following it, given the *previous*
 * validated origin context. Returns the validated URL or throws.
 *
 * Used by `fetchSafe` to prevent SSRF via cross-origin / private redirects.
 */
export function validateRedirect(
  location: string,
  base: string,
  options: ValidateUrlOptions = {},
): SafeUrl {
  if (!location) throw new ApiError(502, "Upstream returned no redirect location");
  let resolved: URL;
  try {
    resolved = new URL(location, base);
  } catch {
    throw new ApiError(502, "Upstream returned an invalid redirect");
  }
  return validateMcpServerUrl(resolved.href, options);
}

/** True when a URL origin is the same as the app origin. */
export function isSameOrigin(url: string, appOrigin: string): boolean {
  try {
    return new URL(url).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}
