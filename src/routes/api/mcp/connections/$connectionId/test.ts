import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { testMcpConnection, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/connections/$connectionId/test")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const parts = new URL(request.url).pathname.split("/");
          const connectionId = parts.at(-2)!;
          return Response.json({
            connection: await testMcpConnection(env, user.id, connectionId),
          });
        },
        { sameOrigin: true },
      ),
    },
  },
});
