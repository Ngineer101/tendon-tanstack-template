import { BILLING_CATALOG } from "#/lib/billing/config";

export const MCP_SERVER_STATUSES = [
  "pending_auth",
  "connected",
  "needs_auth",
  "error",
  "disconnected",
] as const;

export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

export const MCP_SERVER_NAME_MAX_LENGTH = 60;
export const FREE_MCP_SERVER_LIMIT = BILLING_CATALOG.limits.freeMcpServers;

export interface McpServerInfo {
  name?: string;
  version?: string;
  title?: string;
  capabilities?: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
  };
  protocolVersion?: string;
}

export interface PublicMcpServer {
  id: string;
  name: string;
  url: string;
  status: McpServerStatus;
  authType: "oauth" | "none" | null;
  scope: string | null;
  serverInfo: McpServerInfo | null;
  lastConnectedAt: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface McpServerListResponse {
  servers: PublicMcpServer[];
  limit: {
    used: number;
    max: number | null;
    plan: "free" | "pro_monthly";
  };
}
