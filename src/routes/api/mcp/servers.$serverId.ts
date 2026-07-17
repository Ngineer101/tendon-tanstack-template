import { createFileRoute } from "@tanstack/react-router";

import { getDb } from "#/db";
import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { getMcpEncryptionKey, type McpEnv } from "#/lib/mcp/config.server";
import { deleteMcpServer, toPublicMcpServer, updateMcpServer } from "#/lib/mcp/core.server";

function requireServerId(params: Record<string, string>) {
  const serverId = params.serverId;
  if (!serverId) throw new ApiError(400, "Missing server id");
  return serverId;
}

export const Route = createFileRoute("/api/mcp/servers/$serverId")({
  server: {
    handlers: {
      PATCH: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user, params }) => {
          const body = (await request.json().catch(() => ({}))) as {
            name?: unknown;
            url?: unknown;
          };
          const server = await updateMcpServer(getDb(env.DB), {
            userId: user.id,
            serverId: requireServerId(params),
            name: body.name,
            url: body.url,
          });
          return Response.json({ server: toPublicMcpServer(server) });
        },
        { sameOrigin: true },
      ),
      DELETE: authenticatedApiHandler<McpEnv>(
        async ({ env, user, params }) => {
          await deleteMcpServer(getDb(env.DB), getMcpEncryptionKey(env), {
            userId: user.id,
            serverId: requireServerId(params),
          });
          return Response.json({ ok: true });
        },
        { sameOrigin: true },
      ),
    },
  },
});
