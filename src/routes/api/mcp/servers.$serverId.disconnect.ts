import { createFileRoute } from "@tanstack/react-router";

import { getDb } from "#/db";
import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { getMcpEncryptionKey, type McpEnv } from "#/lib/mcp/config.server";
import { disconnectMcpServer, toPublicMcpServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/disconnect")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, user, params }) => {
          if (!params.serverId) throw new ApiError(400, "Missing server id");
          const server = await disconnectMcpServer(getDb(env.DB), getMcpEncryptionKey(env), {
            userId: user.id,
            serverId: params.serverId,
          });
          return Response.json({ server: toPublicMcpServer(server) });
        },
        { sameOrigin: true },
      ),
    },
  },
});
