import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { beginAuthorization, getMcpDeps, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/authorize")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, user, params }) => {
          const serverId = params.serverId;
          if (!serverId) throw new ApiError(400, "Missing server id");
          return Response.json(
            await beginAuthorization(getMcpDeps(env), user.id, serverId, origin),
          );
        },
        { sameOrigin: true },
      ),
    },
  },
});
