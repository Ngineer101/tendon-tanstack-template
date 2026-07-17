import type { McpConnectResponse, McpServerListResponse, McpServerSummary } from "#/lib/mcp/config";

export class McpApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly limit?: number,
  ) {
    super(message);
    this.name = "McpApiError";
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  } catch {
    throw new McpApiError("Network error. Check your connection and try again.", 0);
  }

  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    limit?: number;
  };

  if (!response.ok) {
    throw new McpApiError(
      body.error ?? "Something went wrong. Please try again.",
      response.status,
      body.code,
      body.limit,
    );
  }

  return body as T;
}

export const mcpApi = {
  list: () => requestJson<McpServerListResponse>("/api/mcp/servers"),
  connect: (input: { name: string; serverUrl: string }) =>
    requestJson<McpConnectResponse>("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (serverId: string, input: { name?: string; serverUrl?: string }) =>
    requestJson<McpConnectResponse>(`/api/mcp/servers/${serverId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  disconnect: (serverId: string) =>
    requestJson<{ ok: boolean }>(`/api/mcp/servers/${serverId}`, { method: "DELETE" }),
  testConnection: (serverId: string) =>
    requestJson<{ server: McpServerSummary }>(`/api/mcp/servers/${serverId}/test-connection`, {
      method: "POST",
    }),
  reconnect: (serverId: string) =>
    requestJson<McpConnectResponse>(`/api/mcp/servers/${serverId}/reconnect`, {
      method: "POST",
    }),
};

export const MCP_SERVERS_QUERY_KEY = ["mcp-servers"] as const;
