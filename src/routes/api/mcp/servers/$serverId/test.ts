import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { testMcpServer, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/test")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, params, user }) => {
          await testMcpServer(env, user.id, params.serverId);
          return Response.json({ ok: true });
        },
        { sameOrigin: true },
      ),
    },
  },
});
