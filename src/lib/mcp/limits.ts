import { ApiError } from "#/lib/api-error";
import { FREE_MCP_SERVER_LIMIT } from "./types";

export function canConnectMcpServer(unlimited: boolean, configuredCount: number) {
  return unlimited || configuredCount < FREE_MCP_SERVER_LIMIT;
}

export class McpConnectionLimitError extends ApiError {
  constructor() {
    super(403, `Free accounts can connect up to ${FREE_MCP_SERVER_LIMIT} MCP servers`, {
      code: "mcp_server_limit_reached",
      limit: FREE_MCP_SERVER_LIMIT,
      upgradeUrl: "/billing",
    });
    this.name = "McpConnectionLimitError";
  }
}

export const MCP_CONNECTION_INSERT_SQL = `
  INSERT INTO mcp_connection (
    id, user_id, name, server_url, status, auth_type, created_at, updated_at
  )
  SELECT ?1, ?2, ?3, ?4, 'pending', 'oauth', unixepoch(), unixepoch()
  WHERE ?5 = 1 OR (
    SELECT COUNT(*) FROM mcp_connection WHERE user_id = ?2
  ) < ${FREE_MCP_SERVER_LIMIT}
`;
