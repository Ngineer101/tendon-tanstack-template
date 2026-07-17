import type { McpServerListResponse, PublicMcpServer } from "#/lib/mcp/config";

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

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  } catch {
    throw new McpApiError("Network error — check your connection and try again", 0);
  }
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  } & T;
  if (!response.ok) {
    throw new McpApiError(
      body.error ?? "Something went wrong — please try again",
      response.status,
      body.code,
    );
  }
  return body;
}

export function listServers() {
  return requestJson<McpServerListResponse>("/api/mcp/servers");
}

export function createServer(input: { name: string; url: string }) {
  return requestJson<{ server: PublicMcpServer }>("/api/mcp/servers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateServer(serverId: string, input: { name: string; url: string }) {
  return requestJson<{ server: PublicMcpServer }>(`/api/mcp/servers/${serverId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function authorizeServer(serverId: string) {
  return requestJson<
    { kind: "connected"; server: PublicMcpServer } | { kind: "authorize"; authorizeUrl: string }
  >(`/api/mcp/servers/${serverId}/authorize`, { method: "POST", body: "{}" });
}

export function testServer(serverId: string) {
  return requestJson<{ healthy: boolean; server: PublicMcpServer }>(
    `/api/mcp/servers/${serverId}/ping`,
    { method: "POST", body: "{}" },
  );
}

export function disconnectServer(serverId: string) {
  return requestJson<{ server: PublicMcpServer }>(`/api/mcp/servers/${serverId}/disconnect`, {
    method: "POST",
    body: "{}",
  });
}

export function removeServer(serverId: string) {
  return requestJson<{ ok: boolean }>(`/api/mcp/servers/${serverId}`, { method: "DELETE" });
}
