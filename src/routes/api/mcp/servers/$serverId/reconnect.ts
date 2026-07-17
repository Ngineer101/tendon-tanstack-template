import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpCoreEnv } from "#/lib/mcp/core.server";
import { reconnectServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/reconnect")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpCoreEnv>(
        async ({ env, origin, params, user }) => {
          return Response.json(await reconnectServer(env, user.id, origin, params.serverId));
        },
        { sameOrigin: true },
      ),
    },
  },
});
