import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/config.server";
import { testMcpServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$id/test")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, user, params }) => {
          return Response.json(await testMcpServer(env, user.id, params.id));
        },
        { sameOrigin: true },
      ),
    },
  },
});
