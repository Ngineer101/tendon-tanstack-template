import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { McpServerDto, McpServerUsage } from "#/lib/mcp/config";

export const MCP_SERVERS_QUERY_KEY = ["mcp-servers"] as const;

export interface McpServersResponse {
  servers: McpServerDto[];
  usage: McpServerUsage;
}

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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new McpApiError(
      typeof body.error === "string" ? body.error : "Request failed",
      response.status,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  return body as T;
}

export function useMcpServers(options?: { polling?: boolean }) {
  return useQuery({
    queryKey: MCP_SERVERS_QUERY_KEY,
    queryFn: () => api<McpServersResponse>("/api/mcp/servers"),
    refetchInterval: options?.polling ? 2500 : false,
  });
}

export interface CreateServerResponse {
  server: McpServerDto;
  authorizationUrl: string | null;
}

export function useCreateServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; url: string }) =>
      api<CreateServerResponse>("/api/mcp/servers", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY }),
  });
}

export interface ReconnectResponse {
  authorizationUrl: string | null;
  server: McpServerDto;
}

export function useReconnectServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string) =>
      api<ReconnectResponse>(`/api/mcp/servers/${serverId}/reconnect`, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY }),
  });
}

export function useUpdateServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serverId, ...input }: { serverId: string; name?: string; url?: string }) =>
      api<{ server: McpServerDto }>(`/api/mcp/servers/${serverId}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY }),
  });
}

export function useDeleteServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string) =>
      api<{ ok: boolean }>(`/api/mcp/servers/${serverId}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY }),
  });
}

export interface TestServerResponse {
  ok: boolean;
  server: McpServerDto;
}

export function useTestServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string) =>
      api<TestServerResponse>(`/api/mcp/servers/${serverId}/test`, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY }),
  });
}
