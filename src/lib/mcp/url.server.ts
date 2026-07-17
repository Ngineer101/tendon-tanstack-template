import { ApiError } from "#/lib/api-error";
import { MAX_SERVER_URL_LENGTH } from "./config.server";

/**
 * SSRF protection for user-supplied MCP server URLs.
 *
 * Two layers:
 *  - `parsePublicHttpUrl` synchronously rejects non-HTTP(s) URLs, embedded
 *    credentials, and hostnames that are literal private/reserved IPs or
 *    well-known internal names.
 *  - `assertPubliclyResolvable` additionally resolves the hostname through
 *    DNS-over-HTTPS and rejects names that resolve to non-public addresses.
 *
 * Residual risk (documented in docs/mcp-servers.md): a DNS record can still be
 * re-bound between validation and the actual fetch (TOCTOU). Workers does not
 * offer connect-by-IP, so hostname validation is the strongest available
 * portable control.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
  "169.254.169.254", // also covered by the IPv4 range check, listed for clarity
]);

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function parseIpv4(hostname: string): number[] | undefined {
  // WHATWG URL parsing normalizes decimal/hex/octal IPv4 notations to dotted
  // quads, so a strict dotted-quad check here is sufficient.
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return undefined;
  return octets;
}

function isPublicIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  if (a === 127) return false; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 2) return false; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return false; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return false; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return true;
}

function isPublicIpv6(hostname: string): boolean {
  // Strip zone id and brackets; WHATWG keeps brackets for IPv6 literals.
  const bare = hostname
    .replace(/^\[|\]$/g, "")
    .split("%")[0]
    .toLowerCase();
  if (!bare.includes(":")) return true; // not IPv6

  // IPv4-mapped / compatible addresses are checked via their IPv4 tail.
  const mapped = bare.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const octets = parseIpv4(mapped[1]);
    return octets ? isPublicIpv4(octets) : false;
  }

  if (bare === "::" || bare === "::1") return false; // unspecified + loopback
  const firstSegment = bare.split(":")[0];
  const first = Number.parseInt(firstSegment || "0", 16);
  if (Number.isNaN(first)) return false;
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (first === 0x2001 && bare.startsWith("2001:db8")) return false; // documentation
  if (first === 0 && !bare.startsWith("2000")) return false; // mostly reserved/unassigned space
  return true;
}

export function isPublicHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;
  if (BLOCKED_HOSTNAMES.has(normalized)) return false;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return false;

  const ipv4 = parseIpv4(normalized);
  if (ipv4) return isPublicIpv4(ipv4);
  if (normalized.startsWith("[") || normalized.includes(":")) return isPublicIpv6(normalized);
  return true;
}

/**
 * Parses and validates a user-supplied MCP server URL. Returns the normalized
 * URL (trailing slashes and default ports removed where possible).
 *
 * @throws ApiError 400 with a user-safe message when the URL is unacceptable.
 */
export function parsePublicHttpUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_SERVER_URL_LENGTH) {
    throw new ApiError(400, "Enter a valid server URL");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiError(400, "Enter a valid URL, e.g. https://mcp.example.com/mcp");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ApiError(400, "Only http(s) MCP servers are supported");
  }
  if (url.protocol === "http:") {
    throw new ApiError(400, "MCP servers must use https");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "URLs with embedded credentials are not allowed");
  }
  if (!isPublicHostname(url.hostname)) {
    throw new ApiError(400, "The server URL must point to a public host");
  }

  url.hash = "";
  return url;
}

interface DnsAnswer {
  data?: string;
}

/**
 * Resolves the hostname via DNS-over-HTTPS and rejects names resolving to
 * non-public addresses. Fails closed when DNS cannot be resolved at all.
 */
export async function assertPubliclyResolvable(
  url: URL,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const hostname = url.hostname;
  // Literal IPs were already validated synchronously.
  if (parseIpv4(normalizeHostname(hostname)) || hostname.includes(":")) return;

  const query = new URL("https://cloudflare-dns.com/dns-query");
  query.searchParams.set("name", hostname);
  query.searchParams.set("type", "A");

  let answers: DnsAnswer[] = [];
  let v6Answers: DnsAnswer[] = [];
  try {
    const [aResponse, aaaaResponse] = await Promise.all([
      fetchFn(query, { headers: { accept: "application/dns-json" } }),
      (() => {
        const v6Query = new URL(query);
        v6Query.searchParams.set("type", "AAAA");
        return fetchFn(v6Query, { headers: { accept: "application/dns-json" } });
      })(),
    ]);
    if (!aResponse.ok && !aaaaResponse.ok) {
      throw new ApiError(400, "The server hostname could not be resolved");
    }
    if (aResponse.ok) {
      answers = ((await aResponse.json()) as { Answer?: DnsAnswer[] }).Answer ?? [];
    }
    if (aaaaResponse.ok) {
      v6Answers = ((await aaaaResponse.json()) as { Answer?: DnsAnswer[] }).Answer ?? [];
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "The server hostname could not be resolved");
  }

  const records = [...answers, ...v6Answers]
    .map((answer) => answer.data)
    .filter((data): data is string => typeof data === "string");
  if (!records.length) {
    throw new ApiError(400, "The server hostname could not be resolved");
  }
  for (const record of records) {
    if (!isPublicHostname(record)) {
      throw new ApiError(400, "The server URL must point to a public host");
    }
  }
}

/**
 * Strips query strings, fragments and credential-like material from arbitrary
 * text before it is stored or logged. Never include tokens in `lastError`.
 */
export function sanitizeForLog(value: string, maxLength = 200): string {
  return value
    .replace(/[?&#][^\s"']*/g, "")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .slice(0, maxLength);
}
