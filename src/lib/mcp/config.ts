// Client-safe MCP configuration and types. Never put secrets in this file.

export const MCP_FREE_SERVER_LIMIT = 3;

export const MCP_SERVER_NAME_MAX_LENGTH = 60;

export type McpServerStatus = "connected" | "needs_auth" | "error";

export type McpAuthType = "none" | "oauth";

export interface McpServerInfo {
  name?: string;
  version?: string;
}

// The shape returned to the browser. Auth data and OAuth client configuration
// stay server-side only.
export interface McpServerSummary {
  id: string;
  name: string;
  serverUrl: string;
  status: McpServerStatus;
  authType: McpAuthType;
  serverInfo: McpServerInfo | null;
  lastError: string | null;
  lastConnectedAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface McpServerListResponse {
  servers: McpServerSummary[];
  usage: {
    used: number;
    limit: number | null;
    unlimited: boolean;
  };
}

export interface McpConnectResponse {
  server: McpServerSummary;
  // Present when the server requires OAuth; the browser should navigate here.
  authorizationUrl: string | null;
}

export const MCP_ERROR_CODES = {
  limitReached: "mcp_server_limit_reached",
  duplicateServer: "mcp_server_duplicate",
} as const;
