import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { disconnectMcpServer, updateMcpServer, type McpEnv } from "#/lib/mcp/core.server";

async function readJson<T>(request: Request) {
  return (await request.json().catch(() => ({}))) as Partial<T>;
}

export const Route = createFileRoute("/api/mcp/servers/$serverId")({
  server: {
    handlers: {
      PATCH: authenticatedApiHandler<McpEnv>(
        async ({ env, params, request, user }) => {
          const { serverId } = params;
          const body = await readJson<{ name: string; serverUrl: string }>(request);
          await updateMcpServer(env, user.id, serverId, {
            name: body.name,
            serverUrl: body.serverUrl,
          });
          return Response.json({ ok: true });
        },
        { sameOrigin: true },
      ),
      DELETE: authenticatedApiHandler<McpEnv>(
        async ({ env, params, user }) => {
          const { serverId } = params;
          await disconnectMcpServer(env, user.id, serverId);
          return Response.json({ ok: true });
        },
        { sameOrigin: true },
      ),
    },
  },
});
