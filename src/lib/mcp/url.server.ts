import { ApiError } from "#/lib/api-error";

export interface NormalizedUrl {
  url: string;
  origin: string;
  host: string;
  protocol: string;
}

// Hostnames that resolve to local/private infrastructure and must never be
// contacted by the server when discovering or testing an MCP server.
const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "169.254.170.2",
  "fd00:0:0:0:0:0:0:1",
]);

const PRIVATE_IP_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // private class A
  /^192\.168\./, // private class C
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // private class B
  /^169\.254\./, // link-local
  /^0\./, // "this" network
  /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./, // CGNAT
  /^255\./, // broadcast
];

const IPV6_PRIVATE = [
  /^::1$/, // loopback
  /^fc/, // unique local
  /^fd/, // unique local
  /^fe[89a-f]/, // link-local
  /^::ffff:/, // v4-mapped (check the embedded v4)
];

export interface SsrfOptions {
  // When true, allow `http:` and `127.0.0.1`/`localhost` hosts (local dev only).
  allowInsecureHttp?: boolean;
}

// Validate and normalise an outbound URL the server is about to fetch. Throws
// `ApiError` (400) for any URL that is not safe to contact or that could be
// used to reach private infrastructure, leak credentials, or perform an open
// redirect. This function is intentionally pure and side-effect free so it
// can be unit-tested without a network.
export function validateOutboundUrl(raw: string, options: SsrfOptions = {}): NormalizedUrl {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ApiError(400, "Server URL is required");
  }
  if (raw.length > 2048) {
    throw new ApiError(400, "Server URL is too long");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ApiError(400, "Server URL is not a valid URL");
  }

  if (parsed.username || parsed.password) {
    throw new ApiError(400, "Server URL must not contain credentials");
  }
  if (parsed.hash) {
    throw new ApiError(400, "Server URL must not contain a fragment");
  }

  const protocol = parsed.protocol.toLowerCase();
  const allowHttp = options.allowInsecureHttp ?? false;
  if (protocol !== "https:" && !(allowHttp && protocol === "http:")) {
    throw new ApiError(
      400,
      allowHttp ? "Server URL must use http or https" : "Server URL must use https",
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) throw new ApiError(400, "Server URL must include a host");

  // Block IDN homograph attacks: disallow punycode form; users must type a
  // canonical hostname. ASCII-only hostname check.
  if (host.includes("xn--")) {
    throw new ApiError(400, "Internationalized hostnames are not supported");
  }
  // Printable ASCII only (excludes control chars 0x00-0x1F and 0x7F). Hostnames
  // are limited to letters, digits, hyphens and dots, so this rejects IDN
  // hosts that `new URL` would leave as Unicode rather than punycode.
  if (/[^ -~]/.test(host)) {
    throw new ApiError(400, "Internationalized hostnames are not supported");
  }

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new ApiError(400, "This server URL is not allowed");
  }

  // Loopback handling. localhost / 127.0.0.1 are permitted only when insecure
  // HTTP is explicitly enabled (dev). Otherwise block.
  const isLoopbackHost = host === "localhost" || host.startsWith("127.");
  if (isLoopbackHost && !allowHttp) {
    throw new ApiError(400, "Loopback targets are not allowed");
  }

  if (!isLoopbackHost && PRIVATE_IP_PATTERNS.some((re) => re.test(host))) {
    throw new ApiError(400, "Private IP targets are not allowed");
  }

  if (IPV6_PRIVATE.some((re) => re.test(host))) {
    throw new ApiError(400, "Private IP targets are not allowed");
  }

  if (host.endsWith(".internal") || host.endsWith(".local")) {
    throw new ApiError(400, "This server URL is not allowed");
  }

  // Default port is omitted by URL; otherwise restrict to sane ports.
  if (parsed.port && !/^\d{1,5}$/.test(parsed.port)) {
    throw new ApiError(400, "Server URL has an invalid port");
  }

  // Canonicalise: strip trailing slash on the path but keep at least "/".
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path === "") path = "/";

  const canonical = `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  const origin = `${parsed.protocol}//${parsed.host}`;

  return { url: canonical, origin, host, protocol };
}

// Ensure a redirect/callback URL shares the same origin as the MCP server we
// initiated auth against. Prevents the authorization response being sent to
// an attacker-controlled host.
export function assertSameOriginRedirect(serverOrigin: string, redirectUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    throw new ApiError(400, "Redirect URL is not valid");
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(400, "Redirect URL must not contain credentials");
  }
  const server = new URL(serverOrigin);
  if (
    parsed.protocol.toLowerCase() !== server.protocol.toLowerCase() ||
    parsed.host.toLowerCase() !== server.host.toLowerCase()
  ) {
    throw new ApiError(400, "Redirect URL must match the server origin");
  }
}
