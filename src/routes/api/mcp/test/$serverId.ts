import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/config.server";
import { testServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/test/$serverId")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, params, user }) => {
          const result = await testServer(env, user.id, params.serverId);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
