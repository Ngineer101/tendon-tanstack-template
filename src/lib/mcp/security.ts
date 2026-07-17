import { ApiError } from "#/lib/api-error";

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home",
  ".lan",
  ".test",
  ".invalid",
  ".example",
];

function isBlockedIpv4(hostname: string) {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isBlockedIpv6(hostname: string) {
  const unwrapped = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!unwrapped.includes(":")) return false;

  // Restrict literal IPv6 targets to public global unicast (2000::/3). Hostnames
  // remain supported and are resolved by the Workers public fetch network.
  return !/^[23][0-9a-f]{0,3}:/.test(unwrapped);
}

export function validateExternalUrl(value: string, label = "MCP server URL") {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, `${label} must be a valid URL`, { code: "invalid_url" });
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const isBlockedName =
    hostname === "localhost" ||
    !hostname.includes(".") ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isBlockedName ||
    isBlockedIpv4(hostname) ||
    isBlockedIpv6(hostname)
  ) {
    throw new ApiError(400, `${label} must use a public HTTPS address`, {
      code: "unsafe_url",
    });
  }

  url.hostname = hostname;
  return url;
}

export function canonicalizeMcpServerUrl(value: string) {
  const url = validateExternalUrl(value);
  url.search = "";
  return url.pathname === "/" ? url.origin : url.toString();
}

export function safeRedirectTarget(value: string, expectedOrigin?: string) {
  const target = validateExternalUrl(value, "OAuth endpoint");
  if (expectedOrigin && target.origin !== expectedOrigin) {
    throw new ApiError(400, "The OAuth server returned an unsafe redirect", {
      code: "unsafe_redirect",
    });
  }
  return target;
}

export function parseWwwAuthenticateMetadata(header: string | null) {
  if (!header) return undefined;
  const match = /(?:^|,|\s)resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  return match?.[1];
}

export function parseWwwAuthenticateScope(header: string | null) {
  if (!header) return undefined;
  const match = /(?:^|,|\s)scope\s*=\s*"([^"]+)"/i.exec(header);
  return match?.[1]
    ?.split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}
