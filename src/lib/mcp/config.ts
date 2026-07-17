// Shared, client-safe constants and types for MCP server connections.
// Server-only logic lives in `*.server.ts` files next to this module.

export const FREE_MCP_SERVER_LIMIT = 3;

export const MCP_SERVER_STATUSES = [
  "pending_auth",
  "connected",
  "reconnect_required",
  "error",
] as const;

export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

export const MCP_AUTH_TYPES = ["unknown", "none", "oauth"] as const;

export type McpAuthType = (typeof MCP_AUTH_TYPES)[number];

/**
 * Client-safe view of a connected MCP server. This shape must never include
 * tokens, client secrets, or encrypted blobs.
 */
export interface McpServerDto {
  id: string;
  name: string;
  url: string;
  status: McpServerStatus;
  authType: McpAuthType;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerUsage {
  count: number;
  /** `null` means unlimited (paid plan). */
  limit: number | null;
}
