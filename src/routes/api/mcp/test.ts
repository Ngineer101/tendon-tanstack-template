import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { MCPEnv } from "#/lib/mcp/core.server";
import { testConnection } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/test")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<MCPEnv>(
        async ({ env, request, user }) => {
          const body = (await request.json()) as { serverId?: string };
          if (typeof body.serverId !== "string") {
            return Response.json({ error: "Server ID is required" }, { status: 400 });
          }

          const result = await testConnection(env, user.id, body.serverId);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
