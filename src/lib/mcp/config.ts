import type { BillingEnv } from "#/lib/billing/config.server";

export interface MCPEnv extends BillingEnv {
  MCP_ENCRYPTION_KEY: string;
}

export type MCPAuthStatus = "pending" | "active" | "error" | "expired";

export interface MCPServerRecord {
  id: string;
  userId: string;
  label: string;
  serverUrl: string;
  oauthDiscoveryUrl: string | null;
  encryptedAuthToken: string | null;
  authStatus: MCPAuthStatus;
  lastTestedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MCPServerSummary {
  id: string;
  label: string;
  serverUrl: string;
  authStatus: MCPAuthStatus;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface OAuthDiscoveryDocument {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  responseTypesSupported?: string[];
  grantTypesSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  revocationEndpoint?: string;
}

export const MCP_FREE_LIMIT = 3;

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^\[::1\]$/i,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/,
  /^fc00:/i,
  /^fd00:/i,
  /^fe80:/i,
  /\.local$/i,
  /\.internal$/i,
  /\.corp$/i,
];

export function isSafeUrl(rawUrl: string): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: "Invalid URL format" };
  }

  if (parsed.protocol !== "https:") {
    return { valid: false, reason: "Only HTTPS URLs are allowed" };
  }

  if (!parsed.hostname) {
    return { valid: false, reason: "URL must include a hostname" };
  }

  const hostname = parsed.hostname.toLowerCase().trim();

  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      return { valid: false, reason: "Private or internal URLs are not allowed" };
    }
  }

  const parts = hostname.split(".");
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    return { valid: false, reason: "Invalid hostname" };
  }

  if (parts.length === 1 && !hostname.includes(":")) {
    return { valid: false, reason: "Single-label hostnames are not allowed" };
  }

  if (hostname.match(/^\d+\.\d+\.\d+\.\d+$/)) {
    return { valid: false, reason: "Raw IP addresses are not allowed" };
  }

  if (hostname.includes(":")) {
    if (!hostname.startsWith("[") || !hostname.endsWith("]")) {
      return { valid: false, reason: "IPv6 must use bracket notation" };
    }
  }

  return { valid: true };
}
