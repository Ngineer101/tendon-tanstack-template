import { ApiError } from "#/lib/api-error";
import { MCP_ERROR_CODES } from "./config";

// SSRF guard for user-supplied and discovered URLs. Server-side fetches must only
// target public https endpoints; loopback, private, and link-local hosts are
// rejected. MCP_ALLOW_PRIVATE_NETWORK=true relaxes this for local development.
//
// Limitation: hostnames are checked lexically. A public hostname resolving to a
// private address (DNS rebinding) cannot be detected from a Cloudflare Worker;
// in production the Workers runtime itself cannot reach the private network.

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);

function invalidUrl(message: string): ApiError {
  return new ApiError(400, message, { code: MCP_ERROR_CODES.invalid_url });
}

function parseIpv4(hostname: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 docs
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "::" || host === "::1") return true;
  if (
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb")
  ) {
    return true; // fe80::/10 link-local
  }
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // fc00::/7 unique local
  if (host.startsWith("::ffff:")) {
    const mapped = parseIpv4(host.slice("::ffff:".length));
    return !mapped || isPrivateIpv4(mapped);
  }
  return false;
}

export interface UrlGuardOptions {
  allowPrivateNetwork?: boolean;
  purpose?: string;
}

export function assertSafePublicUrl(raw: string, options: UrlGuardOptions = {}): URL {
  const purpose = options.purpose ?? "Server URL";
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalidUrl(`${purpose} is not a valid URL`);
  }

  if (url.username || url.password) {
    throw invalidUrl(`${purpose} must not contain credentials`);
  }

  if (options.allowPrivateNetwork) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw invalidUrl(`${purpose} must use http(s)`);
    }
    return url;
  }

  if (url.protocol !== "https:") {
    throw invalidUrl(`${purpose} must use https`);
  }

  const hostname = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    !hostname.includes(".")
  ) {
    throw invalidUrl(`${purpose} must point to a public host`);
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4 && isPrivateIpv4(ipv4)) {
    throw invalidUrl(`${purpose} must not point to a private network`);
  }
  if ((hostname.includes(":") || raw.includes("[")) && isPrivateIpv6(url.hostname)) {
    throw invalidUrl(`${purpose} must not point to a private network`);
  }

  return url;
}

// Canonical identifier for an MCP server: origin + path, no fragment, no trailing slash.
// The query string is preserved because some servers key transports off it.
export function canonicalizeServerUrl(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}${url.search}`;
}
