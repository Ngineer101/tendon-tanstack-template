/**
 * Client-side types and fetch helpers for the MCP server connection feature.
 * These mirror the server DTOs in `src/lib/mcp/core.server.ts` — auth tokens
 * are never part of any payload.
 */

export interface McpServerDto {
  id: string;
  name: string;
  url: string;
  status: "connected" | "requires_auth" | "error";
  authType: "oauth" | "none";
  serverName: string | null;
  serverVersion: string | null;
  lastError: string | null;
  lastTestedAt: string | null;
  createdAt: string;
}

export interface McpServerQuota {
  plan: "free" | "pro_monthly";
  used: number;
  limit: number | null;
}

export interface McpServerListResponse {
  servers: McpServerDto[];
  quota: McpServerQuota;
}

export type StartConnectionResponse =
  | { type: "connected"; server: McpServerDto }
  | { type: "authorization_required"; authorizationUrl: string; expiresAt: string };

export interface TestServerResponse {
  ok: boolean;
  toolCount: number;
  serverName: string | null;
  serverVersion: string | null;
}

export async function apiRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? "Something went wrong. Please try again.");
  }
  return payload;
}
