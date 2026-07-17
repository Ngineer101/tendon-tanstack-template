// Server-side configuration for MCP server connections.
//
// Secrets (MCP_ENCRYPTION_KEY) MUST be provisioned via Wrangler secrets or the
// local `.env.local` file — never committed to the database or source. The key
// is a base64-encoded 256-bit AES key used by AES-GCM to encrypt OAuth tokens
// at rest.

export interface McpEnv extends Cloudflare.Env {
  // Base64 (raw 32 bytes) AES-256 key used to encrypt credentials at rest.
  MCP_ENCRYPTION_KEY: string;
  // Public redirect URI used for the OAuth callback. Defaults to
  // `${BETTER_AUTH_URL}/api/mcp/oauth/callback` when unset.
  MCP_OAUTH_REDIRECT_URL?: string;
}

// Number of MCP servers a free-tier (no active Pro subscription) user may
// connect. Paying users (`pro_monthly` plan) have an unlimited allowance.
export const FREE_MCP_SERVER_LIMIT = 3;

// OAuth state validity window. Short so a stolen state cannot be replayed.
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// HTTP fetch timeout for MCP server metadata / token endpoint probes.
export const MCP_FETCH_TIMEOUT_MS = 10_000;

// Fan-out scopes requested during the MCP OAuth flow. MCP servers typically
// accept an empty scope or an opaque scope; we request a conservative default.
export const MCP_DEFAULT_SCOPE = "mcp";

export function getRedirectUri(env: McpEnv): string {
  return (
    env.MCP_OAUTH_REDIRECT_URL ?? `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/api/mcp/oauth/callback`
  );
}
