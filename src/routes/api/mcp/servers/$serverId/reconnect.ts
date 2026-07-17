import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { beginMcpOAuth, type McpEnv } from "#/lib/mcp/core.server";

async function readJson<T>(request: Request) {
  return (await request.json().catch(() => ({}))) as Partial<T>;
}

export const Route = createFileRoute("/api/mcp/servers/$serverId/reconnect")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, params, request, user }) => {
          const body = await readJson<{ name: string; serverUrl: string; scope: string }>(request);
          const result = await beginMcpOAuth(env, {
            userId: user.id,
            connectionId: params.serverId,
            name: body.name,
            serverUrl: String(body.serverUrl ?? ""),
            scope: body.scope,
            origin,
          });
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
