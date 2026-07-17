// Client-safe MCP connection constants and types (no server-only imports).

export const FREE_MCP_SERVER_LIMIT = 3;

export type McpServerStatus = "connected" | "pending_auth" | "error";
export type McpAuthType = "oauth" | "none";

// Serialized shape returned by the /api/mcp endpoints. Never includes auth material.
export interface McpServerView {
  id: string;
  name: string;
  serverUrl: string;
  status: McpServerStatus;
  authType: McpAuthType;
  serverName: string | null;
  serverVersion: string | null;
  toolCount: number | null;
  lastError: string | null;
  lastConnectedAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerListResponse {
  servers: McpServerView[];
  limit: {
    // null means unlimited (paid plan)
    max: number | null;
    used: number;
    canAdd: boolean;
  };
}

export const MCP_ERROR_CODES = {
  server_limit_reached: "server_limit_reached",
  duplicate_server: "duplicate_server",
  invalid_url: "invalid_url",
  unreachable: "unreachable",
  oauth_discovery_failed: "oauth_discovery_failed",
  oauth_registration_failed: "oauth_registration_failed",
  oauth_exchange_failed: "oauth_exchange_failed",
  oauth_state_invalid: "oauth_state_invalid",
  auth_expired: "auth_expired",
  not_found: "not_found",
} as const;

export type McpErrorCode = keyof typeof MCP_ERROR_CODES;
