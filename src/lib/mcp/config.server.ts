export interface McpEnv extends Cloudflare.Env {
  // Base64-encoded 32-byte AES-256-GCM key. Configure via environment secrets
  // (`wrangler secret put MCP_ENCRYPTION_KEY`), never in the database or code.
  MCP_ENCRYPTION_KEY: string;
}

/** Maximum number of MCP servers a user on the free plan can connect. */
export const FREE_TIER_MCP_SERVER_LIMIT = 3;

/** In-flight OAuth authorization transactions expire after 10 minutes. */
export const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;

/** Access tokens are refreshed this long before their expiry to avoid races. */
export const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

/** Network timeout for outbound MCP / OAuth requests. */
export const MCP_FETCH_TIMEOUT_MS = 10_000;

/** Upper bound for MCP server URLs accepted by the API. */
export const MAX_SERVER_URL_LENGTH = 2048;

/** Upper bound for user-provided server display names. */
export const MAX_SERVER_NAME_LENGTH = 80;
