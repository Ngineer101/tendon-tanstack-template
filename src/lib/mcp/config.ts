// Shared, client-safe constants and types for MCP server connections.

export const FREE_MCP_SERVER_LIMIT = 3;

export const MCP_SERVER_STATUSES = ["pending_auth", "connected", "error", "auth_expired"] as const;

export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

export const MCP_AUTH_TYPES = ["none", "oauth"] as const;

export type McpAuthType = (typeof MCP_AUTH_TYPES)[number];

/**
 * The public representation of an MCP server connection. This shape is the
 * only one that may leave the server: it must never contain access tokens,
 * refresh tokens, client secrets, or PKCE material.
 */
export interface McpServerPublic {
  id: string;
  name: string;
  url: string;
  status: McpServerStatus;
  authType: McpAuthType;
  authServerIssuer: string | null;
  serverName: string | null;
  serverVersion: string | null;
  toolCount: number | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/** Reasons surfaced to the dashboard after an OAuth redirect. */
export const MCP_OAUTH_RESULTS = ["connected", "cancelled", "error"] as const;

export type McpOauthResult = (typeof MCP_OAUTH_RESULTS)[number];
