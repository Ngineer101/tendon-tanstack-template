import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { MCPEnv } from "#/lib/mcp/config";
import { testConnection } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$id/test")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<MCPEnv>(
        async ({ env, request, user }) => {
          const url = new URL(request.url);
          const parts = url.pathname.split("/");
          const id = parts[parts.length - 2];
          if (!id || id === "$id") {
            return Response.json({ error: "Server ID is required" }, { status: 400 });
          }

          const result = await testConnection(env, user.id, id);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
