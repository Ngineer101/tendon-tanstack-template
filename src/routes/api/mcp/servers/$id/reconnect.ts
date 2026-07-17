import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/config.server";
import { reconnectMcpServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$id/reconnect")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, user, params }) => {
          return Response.json(await reconnectMcpServer(env, user.id, origin, params.id));
        },
        { sameOrigin: true },
      ),
    },
  },
});
