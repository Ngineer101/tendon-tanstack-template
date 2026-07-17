import { ApiError } from "#/lib/api-error";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "localhost."]);

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isLoopbackHost(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  if (hostname === "::1" || hostname === "[::1]") return true;
  const ipv4 = parseIpv4(hostname);
  return ipv4 !== null && ipv4[0] === 127;
}

/**
 * Returns true when the hostname is an IP literal inside a non-public range.
 * Loopback addresses are reported separately via `isLoopbackHost` because
 * they are allowed for local development.
 */
function isPrivateIpLiteral(hostname: string): boolean {
  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0) return true; // 192.0.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark net
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  // IPv6 literals arrive bracketed and hex-normalized from the URL parser.
  const ipv6 = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (ipv6.includes(":")) {
    if (ipv6 === "::") return true; // unspecified
    if (ipv6.startsWith("fc") || ipv6.startsWith("fd")) return true; // unique local fc00::/7
    if (/^fe[89ab]/.test(ipv6)) return true; // link-local fe80::/10
    if (ipv6.startsWith("::ffff:")) {
      // IPv4-mapped IPv6 (normalized to hex hextets): apply the IPv4 policy
      // to the embedded address.
      const mapped = ipv6.slice("::ffff:".length);
      const hextets = mapped.split(":");
      if (hextets.length === 2) {
        const high = parseInt(hextets[0], 16);
        const low = parseInt(hextets[1], 16);
        if (!Number.isNaN(high) && !Number.isNaN(low)) {
          const octets = [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
          return isPrivateIpLiteral(octets) || octets.startsWith("127.");
        }
      }
      return isPrivateIpLiteral(mapped);
    }
  }
  return false;
}

export interface ValidatedServerUrl {
  /** Normalized URL string (no trailing slash on the path, no fragment). */
  normalized: string;
  url: URL;
  /** Stable display host, e.g. `mcp.example.com`. */
  host: string;
}

/**
 * Validates and normalizes a user-supplied MCP server URL.
 *
 * SSRF policy:
 * - Only `https:` is allowed for public hosts. `http:` is limited to loopback
 *   hosts so developers can connect local servers while iterating.
 * - Credentials in the URL (`user:pass@host`) and fragments are rejected.
 * - Private/link-local/reserved IP literals are rejected; loopback is allowed.
 *
 * Note: DNS-based rebinding protection (resolving hostnames and re-checking
 * the resolved IPs) is not possible from a Cloudflare Worker and is a known
 * limitation documented in docs/mcp-server-connections.md.
 */
export function validateMcpServerUrl(raw: string): ValidatedServerUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ApiError(400, "Enter a valid URL, e.g. https://mcp.example.com/mcp");
  }

  const hostname = url.hostname.toLowerCase();
  const loopback = isLoopbackHost(hostname);

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ApiError(400, "MCP servers must use HTTPS");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "URLs with embedded credentials are not allowed");
  }
  if (!loopback && isPrivateIpLiteral(hostname)) {
    throw new ApiError(400, "Private network addresses are not allowed");
  }

  url.hash = "";
  url.hostname = hostname;
  // Normalize a trailing slash so uniqueness checks are stable.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return { normalized: url.toString(), url, host: url.host };
}

/**
 * Re-validates a redirect target discovered while fetching remote metadata.
 * Redirects may only escalate to HTTPS on any host, or stay on loopback HTTP.
 */
export function assertSafeRedirectTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(502, "MCP server returned an invalid redirect");
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = isLoopbackHost(hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ApiError(502, "MCP server redirected to an insecure URL");
  }
  if (url.username || url.password || (!loopback && isPrivateIpLiteral(hostname))) {
    throw new ApiError(502, "MCP server redirected to a disallowed address");
  }
  return url;
}
