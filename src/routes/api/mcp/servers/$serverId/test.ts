import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpApiEnv } from "#/lib/mcp/config.server";
import { testServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/test")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpApiEnv>(
        async ({ env, params, user }) => {
          return Response.json(await testServer(env, user.id, params.serverId));
        },
        { sameOrigin: true },
      ),
    },
  },
});
