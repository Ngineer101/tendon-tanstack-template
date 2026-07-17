import type { McpServerListResponse, McpServerView } from "#/lib/mcp/config";

export class McpApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "McpApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  } & T;
  if (!response.ok) {
    throw new McpApiError(body.error ?? "Something went wrong", response.status, body.code);
  }
  return body;
}

function jsonInit(method: string, body?: object): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
}

export interface MutationResult {
  server: McpServerView;
  requiresAuth: boolean;
}

export const mcpApi = {
  list: () => request<McpServerListResponse>("/api/mcp/servers"),
  create: (input: { name: string; serverUrl: string }) =>
    request<MutationResult>("/api/mcp/servers", jsonInit("POST", input)),
  update: (serverId: string, patch: { name?: string; serverUrl?: string }) =>
    request<MutationResult>(`/api/mcp/servers/${serverId}`, jsonInit("PATCH", patch)),
  remove: (serverId: string) =>
    request<{ ok: boolean }>(`/api/mcp/servers/${serverId}`, jsonInit("DELETE")),
  test: (serverId: string) =>
    request<{ server: McpServerView; ok: boolean; latencyMs?: number }>(
      `/api/mcp/servers/${serverId}/test-connection`,
      jsonInit("POST"),
    ),
  authorize: (serverId: string) =>
    request<{ authorizationUrl: string }>(
      `/api/mcp/servers/${serverId}/authorize`,
      jsonInit("POST"),
    ),
};
