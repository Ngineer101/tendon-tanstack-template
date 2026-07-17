import { createFileRoute } from "@tanstack/react-router";

import { getDb } from "#/db";
import { authenticatedApiHandler } from "#/lib/api";
import type { McpCoreEnv } from "#/lib/mcp/core.server";
import { getServerQuota, listServers, startConnection } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpCoreEnv>(async ({ env, user }) => {
        const [servers, quota] = await Promise.all([
          listServers(getDb(env.DB), user.id),
          getServerQuota(env, user.id),
        ]);
        return Response.json({ servers, quota });
      }),

      POST: authenticatedApiHandler<McpCoreEnv>(
        async ({ env, origin, request, user }) => {
          const body = (await request.json().catch(() => ({}))) as {
            name?: unknown;
            url?: unknown;
          };
          const result = await startConnection(env, user.id, origin, {
            name: body.name,
            url: body.url,
          });
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
