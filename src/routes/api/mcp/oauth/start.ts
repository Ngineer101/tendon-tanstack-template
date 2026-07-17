import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { MCPEnv } from "#/lib/mcp/core.server";
import { initiateOAuth } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/oauth/start")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<MCPEnv>(
        async ({ env, request, origin, user }) => {
          const body = (await request.json()) as { serverId?: string };
          if (typeof body.serverId !== "string") {
            return Response.json({ error: "Server ID is required" }, { status: 400 });
          }

          const result = await initiateOAuth(env, user.id, body.serverId, origin);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
