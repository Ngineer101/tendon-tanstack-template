import { createFileRoute } from "@tanstack/react-router";

import { ApiError } from "#/lib/api-error";
import { authenticatedApiHandler } from "#/lib/api";
import type { McpCoreEnv } from "#/lib/mcp/core.server";
import { deleteServer, updateServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/")({
  server: {
    handlers: {
      PATCH: authenticatedApiHandler<McpCoreEnv>(
        async ({ env, params, request, user }) => {
          const body = (await request.json().catch(() => ({}))) as {
            name?: unknown;
            url?: unknown;
          };
          if (body.name === undefined && body.url === undefined) {
            throw new ApiError(400, "Nothing to update");
          }
          const server = await updateServer(env, user.id, params.serverId, body);
          return Response.json({ server });
        },
        { sameOrigin: true },
      ),

      DELETE: authenticatedApiHandler<McpCoreEnv>(
        async ({ env, params, user }) => {
          return Response.json(await deleteServer(env, user.id, params.serverId));
        },
        { sameOrigin: true },
      ),
    },
  },
});
