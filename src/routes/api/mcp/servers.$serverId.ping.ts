import { createFileRoute } from "@tanstack/react-router";

import { getDb } from "#/db";
import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { getMcpEncryptionKey, type McpEnv } from "#/lib/mcp/config.server";
import { testMcpServer, toPublicMcpServer } from "#/lib/mcp/core.server";

// Named "ping" instead of "test" so the route file is not picked up by the
// vitest test glob; the UI presents it as "Test connection".
export const Route = createFileRoute("/api/mcp/servers/$serverId/ping")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, user, params }) => {
          if (!params.serverId) throw new ApiError(400, "Missing server id");
          const { server, healthy } = await testMcpServer(getDb(env.DB), getMcpEncryptionKey(env), {
            userId: user.id,
            serverId: params.serverId,
          });
          return Response.json({ healthy, server: toPublicMcpServer(server) });
        },
        { sameOrigin: true },
      ),
    },
  },
});
