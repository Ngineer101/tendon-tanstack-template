import { createFileRoute } from "@tanstack/react-router";

import { getDb } from "#/db";
import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { getMcpEncryptionKey, type McpEnv } from "#/lib/mcp/config.server";
import { beginMcpConnect, toPublicMcpServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/authorize")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, user, params }) => {
          if (!params.serverId) throw new ApiError(400, "Missing server id");
          const result = await beginMcpConnect(getDb(env.DB), getMcpEncryptionKey(env), {
            userId: user.id,
            serverId: params.serverId,
            origin,
          });
          if (result.kind === "connected") {
            return Response.json({
              kind: "connected",
              server: toPublicMcpServer(result.server),
            });
          }
          return Response.json({ kind: "authorize", authorizeUrl: result.authorizeUrl });
        },
        { sameOrigin: true },
      ),
    },
  },
});
