import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpCoreEnv } from "#/lib/mcp/core.server";
import { testServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/test")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpCoreEnv>(
        async ({ env, params, user }) => {
          return Response.json(await testServer(env, user.id, params.serverId));
        },
        { sameOrigin: true },
      ),
    },
  },
});
