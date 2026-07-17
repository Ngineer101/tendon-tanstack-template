import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/config.server";
import { reconnectServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/reconnect/$serverId")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, params, user }) => {
          const result = await reconnectServer(env, user.id, params.serverId, origin);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
