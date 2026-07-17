import { ApiError } from "#/lib/api-error";

// SSRF guards for user-supplied MCP server URLs and every OAuth endpoint we
// discover from them. Only public https origins are allowed: the app runs on
// Cloudflare Workers, so private/loopback addresses could only ever hit
// infrastructure, never the user's own machine.

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".onion"];

function parseIpv4(hostname: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;
  const parts = hostname.split(".").map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

function isBlockedIpv4(parts: number[]) {
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // "this", private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // IETF reserved
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function parseIpv6Groups(hostname: string): number[] | null {
  if (!hostname.includes(":")) return null;
  let head = hostname;
  let tail = "";
  const doubleColon = hostname.indexOf("::");
  if (doubleColon !== -1) {
    head = hostname.slice(0, doubleColon);
    tail = hostname.slice(doubleColon + 2);
  }
  const expand = (section: string) => (section === "" ? [] : section.split(":"));
  const headParts = expand(head);
  const tailParts = expand(tail);

  // An embedded IPv4 suffix (e.g. ::ffff:127.0.0.1) expands to two groups.
  const last = tailParts[tailParts.length - 1] ?? headParts[headParts.length - 1];
  let embeddedIpv4: number[] | null = null;
  if (last?.includes(".")) {
    embeddedIpv4 = parseIpv4(last);
    if (!embeddedIpv4) return null;
    const replacement = [
      ((embeddedIpv4[0] << 8) | embeddedIpv4[1]).toString(16),
      ((embeddedIpv4[2] << 8) | embeddedIpv4[3]).toString(16),
    ];
    (tailParts.length ? tailParts : headParts).splice(-1, 1, ...replacement);
  }

  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0 || (doubleColon === -1 && missing !== 0)) return null;
  const groups = [...headParts, ...Array<string>(missing).fill("0"), ...tailParts];
  if (groups.length !== 8) return null;
  const numeric = groups.map((group) => Number.parseInt(group || "0", 16));
  return numeric.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff)
    ? numeric
    : null;
}

function isBlockedIpv6(groups: number[]) {
  const allZero = groups.every((group) => group === 0);
  if (allZero) return true; // unspecified
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((groups[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if (groups[0] === 0x2001 && groups[1] === 0xdb8) return true; // documentation
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return true; // NAT64
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0xffff || groups[5] === 0)
  ) {
    // IPv4-mapped / IPv4-compatible — check the embedded address.
    return isBlockedIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  return false;
}

export function assertSafeHttpUrl(raw: string, label = "URL"): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ApiError(400, `${label} is not a valid URL`);
  }

  if (url.protocol !== "https:") {
    throw new ApiError(400, `${label} must use https`);
  }
  if (url.username || url.password) {
    throw new ApiError(400, `${label} must not contain credentials`);
  }

  // WHATWG URL parsing canonicalizes numeric hosts (e.g. http://2130706433
  // becomes 127.0.0.1), so checking the parsed hostname covers encoded forms.
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!hostname || hostname === "localhost") {
    throw new ApiError(400, `${label} must point to a public host`);
  }
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new ApiError(400, `${label} must point to a public host`);
  }
  const ipv4 = parseIpv4(hostname);
  if (ipv4 && isBlockedIpv4(ipv4)) {
    throw new ApiError(400, `${label} must point to a public host`);
  }
  const ipv6 = parseIpv6Groups(hostname);
  if (ipv6 && isBlockedIpv6(ipv6)) {
    throw new ApiError(400, `${label} must point to a public host`);
  }

  return url;
}

interface SafeFetchOptions extends RequestInit {
  maxRedirects?: number;
}

// Fetch that never auto-follows redirects. Safe (GET) redirects are followed
// manually with the target re-validated at every hop so a well-known endpoint
// cannot bounce us into a private network. Auth headers are never forwarded
// across origins.
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<Response> {
  const { maxRedirects = 3, ...init } = options;
  let url = assertSafeHttpUrl(rawUrl);

  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(url.toString(), { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("location");
    const method = (init.method ?? "GET").toUpperCase();
    if (!location || method !== "GET" || redirects >= maxRedirects) {
      throw new ApiError(502, "The server responded with an unexpected redirect");
    }
    const next = assertSafeHttpUrl(new URL(location, url).toString(), "Redirect target");
    if (next.origin !== url.origin) {
      const headers = new Headers(init.headers);
      headers.delete("authorization");
      init.headers = headers;
    }
    url = next;
  }
}
