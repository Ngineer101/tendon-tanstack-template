/**
 * MCP feature configuration and environment typing.
 *
 * Secrets:
 *  - `MCP_ENCRYPTION_KEY` (base64url, 32 bytes) is the AES-GCM key used to
 *    encrypt OAuth tokens at rest. It MUST be provisioned as a Workers secret
 *    (`wrangler secret put MCP_ENCRYPTION_KEY`) and MUST NOT be stored in the
 *    database, source, or wrangler.jsonc.
 *
 * Limits:
 *  - Free users may connect at most `FREE_SERVER_LIMIT` MCP servers.
 *  - Pro (paying) users with the `unlimited_mcp_servers` entitlement have
 *    unlimited connections. The entitlement is enforced server-side via the
 *    existing billing/entitlement system (see `lib/billing`).
 */
export interface McpEnv extends Cloudflare.Env {
  MCP_ENCRYPTION_KEY: string;
}

/** Max MCP servers a free-tier user may connect. */
export const FREE_SERVER_LIMIT = 3;

/** Status enum stored in `mcp_server.status`. */
export const McpServerStatus = {
  /** Created but OAuth not yet completed. */
  pending: "pending",
  /** Connected and usable. */
  active: "active",
  /** Tokens rejected / connectivity failed. User should reconnect. */
  error: "error",
  /** Soft-disconnected by the user; tokens retained but unused. */
  disconnected: "disconnected",
} as const;

export type McpServerStatus = (typeof McpServerStatus)[keyof typeof McpServerStatus];

export const ACTIVE_STATUSES: ReadonlySet<McpServerStatus> = new Set([McpServerStatus.active]);

/** OAuth flow state lifetime, in milliseconds. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
