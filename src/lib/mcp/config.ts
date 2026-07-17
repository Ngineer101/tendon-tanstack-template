// Limits and labels for the MCP server feature.

export const MCP_LIMITS = {
  // Free users may connect at most this many MCP servers. Pro users have the
  // `unlimited_mcp_servers` entitlement and bypass this limit.
  freeServerLimit: 3,
} as const;

export const MCP_ENTITLEMENT = "unlimited_mcp_servers" as const;

// Server lifecycle statuses stored in `mcp_server.status`.
export const MCP_STATUS = {
  pending: "pending",
  connected: "connected",
  error: "error",
  disconnected: "disconnected",
} as const;

export type McpStatus = (typeof MCP_STATUS)[keyof typeof MCP_STATUS];

// How long an in-flight OAuth flow is considered valid (10 minutes).
export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export const MCP_RPC = {
  protocolVersion: "2025-06-18",
} as const;
