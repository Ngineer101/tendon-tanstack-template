import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpApiEnv } from "#/lib/mcp/config.server";
import { beginReauthorization } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/reconnect")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpApiEnv>(
        async ({ env, origin, params, user }) => {
          return Response.json(await beginReauthorization(env, user.id, params.serverId, origin));
        },
        { sameOrigin: true },
      ),
    },
  },
});
