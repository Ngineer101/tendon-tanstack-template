import type { BillingEnv } from "#/lib/billing/config.server";

export interface McpEnv extends Cloudflare.Env {
  /**
   * Base64-encoded 32-byte key used to encrypt MCP auth data at rest.
   * Configure via environment secrets only (e.g. `wrangler secret put`),
   * never in the database or source code.
   */
  MCP_ENCRYPTION_KEY: string;
}

/** Env required by flows that also enforce billing entitlements. */
export type McpServerEnv = McpEnv & BillingEnv;

/** Timeout for any outbound request to an MCP server or authorization server. */
export const MCP_FETCH_TIMEOUT_MS = 10_000;

/** How long an OAuth authorization session (state + PKCE verifier) stays valid. */
export const MCP_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;

/** Refresh access tokens this long before they expire. */
export const MCP_TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

/** Maximum number of redirects followed when fetching discovery metadata. */
export const MCP_MAX_REDIRECTS = 3;
