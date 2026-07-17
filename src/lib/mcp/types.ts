// Public client-side types for MCP servers. Mirrors the shapes returned by the
// /api/mcp/servers* endpoints — never includes tokens or endpoint secrets.

export type McpServerStatus = "pending" | "connected" | "disconnected" | "error";

export interface McpServerPublic {
  id: string;
  name: string;
  serverUrl: string;
  status: McpServerStatus;
  lastError: string | null;
  hasCredentials: boolean;
  createdAt: string;
  updatedAt: string;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  supportsDynamicRegistration: boolean;
}

export interface McpListResult {
  servers: McpServerPublic[];
  limit: number | null;
  used: number;
}

export interface DiscoverResult {
  serverUrl: string;
  name: string;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  supportsDynamicRegistration: boolean;
}

export interface ConnectResult {
  serverId: string;
  authorizationUrl: string;
}

export interface TestResult {
  status: McpServerStatus | "disconnected";
  message: string;
}

// Shape of an ApiError returned by the API helpers — kept here so the client
// can read `error` and optional `details` without importing server code.
export interface ApiErrorShape {
  error: string;
  details?: Record<string, unknown>;
}

export function apiError(body: unknown): ApiErrorShape | null {
  if (body && typeof body === "object" && typeof (body as ApiErrorShape).error === "string") {
    return body as ApiErrorShape;
  }
  return null;
}
