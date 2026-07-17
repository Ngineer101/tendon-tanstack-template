import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { reconnectMcpConnection, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/connections/$connectionId/oauth/start")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, request, user }) => {
          const parts = new URL(request.url).pathname.split("/");
          const connectionId = parts.at(-3)!;
          return Response.json(await reconnectMcpConnection(env, user.id, connectionId, origin));
        },
        { sameOrigin: true },
      ),
    },
  },
});
