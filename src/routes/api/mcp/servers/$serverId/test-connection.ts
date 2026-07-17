import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { getMcpDeps, testMcpServer, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/test-connection")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, user, params }) => {
          const serverId = params.serverId;
          if (!serverId) throw new ApiError(400, "Missing server id");
          return Response.json(await testMcpServer(getMcpDeps(env), user.id, serverId));
        },
        { sameOrigin: true },
      ),
    },
  },
});
