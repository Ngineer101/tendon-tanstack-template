import { createFileRoute } from "@tanstack/react-router";
import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/core.server";
import { discoverMcpOAuth } from "#/lib/mcp/core.server";

function extractIdFromPath(request: Request): string {
  const url = new URL(request.url);
  const match = url.pathname.match(/\/api\/mcp\/servers\/([^/]+)\/oauth\/authorize$/);
  if (!match?.[1]) {
    throw new Error("Missing server ID in path");
  }
  return match[1];
}

export const Route = createFileRoute("/api/mcp/servers/$id/oauth/authorize")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const id = extractIdFromPath(request);
          const result = await discoverMcpOAuth(env, user.id, id);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
