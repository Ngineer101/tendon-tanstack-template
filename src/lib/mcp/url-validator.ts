const PRIVATE_IP_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.1[89]\./,
];

const PRIVATE_IPV6_RANGES = [/^::1$/, /^fc00:/i, /^fd00:/i, /^fe80:/i];

function isPrivateIP(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return true;
  }

  if (PRIVATE_IP_RANGES.some((r) => r.test(hostname))) return true;
  if (PRIVATE_IPV6_RANGES.some((r) => r.test(hostname))) return true;

  return false;
}

export interface ValidateUrlResult {
  valid: boolean;
  error?: string;
  normalizedUrl: string;
}

export function validateServerUrl(raw: string): ValidateUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: "URL is required", normalizedUrl: "" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: "Invalid URL format", normalizedUrl: "" };
  }

  if (parsed.protocol !== "https:") {
    return { valid: false, error: "Only HTTPS URLs are allowed", normalizedUrl: "" };
  }

  if (!parsed.hostname) {
    return { valid: false, error: "URL must include a hostname", normalizedUrl: "" };
  }

  const hostname =
    parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;

  if (isPrivateIP(hostname)) {
    return {
      valid: false,
      error: "Cannot connect to local or private network addresses",
      normalizedUrl: "",
    };
  }

  if ("username" in parsed && parsed.username) {
    return { valid: false, error: "URL must not contain credentials", normalizedUrl: "" };
  }

  if (hostname.length > 253) {
    return { valid: false, error: "Hostname is too long", normalizedUrl: "" };
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";

  const normalizedUrl = parsed.origin;

  return { valid: true, normalizedUrl };
}

export function validateRedirectUrl(serverOrigin: string, redirectUri: string): boolean {
  try {
    const redirectUrl = new URL(redirectUri);
    const serverUrl = new URL(serverOrigin);
    return redirectUrl.origin === serverUrl.origin;
  } catch {
    return false;
  }
}
