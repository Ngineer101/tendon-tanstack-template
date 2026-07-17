import { createFileRoute } from "@tanstack/react-router";
import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/core.server";
import { updateMcpServer, deleteMcpServer } from "#/lib/mcp/core.server";

function extractIdFromPath(request: Request, pattern: string): string {
  const url = new URL(request.url);
  const match = url.pathname.match(pattern);
  if (!match?.[1]) {
    throw new Error("Missing server ID in path");
  }
  return match[1];
}

export const Route = createFileRoute("/api/mcp/servers/$id")({
  server: {
    handlers: {
      PUT: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const id = extractIdFromPath(request, "/api/mcp/servers/([^/]+)$");
          const body = (await request.json()) as { label?: string; url?: string };
          const server = await updateMcpServer(env, user.id, id, body);
          return Response.json(server);
        },
        { sameOrigin: true },
      ),
      DELETE: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const id = extractIdFromPath(request, "/api/mcp/servers/([^/]+)$");
          const result = await deleteMcpServer(env, user.id, id);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
