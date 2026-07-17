import { ApiError } from "#/lib/api-error";

/**
 * SSRF-safe validation for user-supplied MCP server URLs (and URLs discovered
 * from OAuth metadata that we later send the user or fetch server-side).
 *
 * What is enforced here:
 * - https: scheme only (credentials never travel in cleartext)
 * - no embedded credentials (user:pass@host) so secrets can't leak via logs/DB
 * - no IP literals in loopback/private/link-local/reserved ranges (v4 + v6)
 * - no loopback or internal-only hostnames (localhost, *.local, *.internal, ...)
 * - hostnames must contain a dot (blocks single-label intranet names)
 *
 * Known limitation: hostnames are not DNS-resolved before fetching, so a
 * public hostname that resolves to a private address (DNS rebinding) cannot
 * be detected here. Workers egress runs from Cloudflare's network, so it
 * cannot reach a customer's private network regardless.
 */

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);
const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".corp", ".lan", ".home"];

function isBlockedIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false; // not a valid literal; DNS will fail anyway
  const [a, b] = octets;

  return (
    a === 0 || // "this" network
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local (cloud metadata endpoints)
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved
  );
}

function isBlockedIpv6(hostname: string): boolean {
  // URL hostnames wrap IPv6 literals in brackets; URL.hostname keeps them.
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value.includes(":")) return false;

  return (
    value === "::1" || // loopback
    value === "::" || // unspecified
    value.startsWith("fe80:") || // link-local
    value.startsWith("fc") || // unique local fc00::/7 (fc.. / fd..)
    value.startsWith("fd") ||
    value.startsWith("::ffff:0:") || // IPv4-mapped loopback range
    value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") ||
    value.startsWith("::ffff:192.168.") ||
    value.startsWith("::ffff:169.254.")
  );
}

function assertSafeHostname(hostname: string) {
  const normalized = hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(normalized)) {
    throw new ApiError(400, "Loopback hostnames are not allowed");
  }
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    throw new ApiError(400, "Internal hostnames are not allowed");
  }
  if (isBlockedIpv4(normalized) || isBlockedIpv6(normalized)) {
    throw new ApiError(400, "Private or reserved network addresses are not allowed");
  }
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(normalized) || normalized.includes("..")) {
    throw new ApiError(400, "Invalid hostname");
  }
  if (!normalized.includes(".")) {
    throw new ApiError(400, "Hostname must be a fully qualified domain name");
  }
}

/**
 * Validates and normalizes a user-supplied MCP server URL. Returns the URL in
 * canonical string form. Throws ApiError(400) with a user-safe message.
 */
export function validateMcpServerUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new ApiError(400, "Enter a valid URL, for example https://mcp.example.com/mcp");
  }

  if (url.protocol !== "https:") {
    throw new ApiError(400, "Only https:// URLs are supported");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "URLs with embedded credentials are not allowed");
  }

  assertSafeHostname(url.hostname);

  url.hash = "";
  return url.toString();
}

/**
 * Validates a URL that came from remote OAuth metadata before we redirect the
 * user to it or fetch it server-side. Uses the same rules as server URLs.
 */
export function validateDiscoveredUrl(rawUrl: string, what: string): string {
  try {
    return validateMcpServerUrl(rawUrl);
  } catch {
    throw new ApiError(502, `The MCP server published an unsafe ${what}`);
  }
}
