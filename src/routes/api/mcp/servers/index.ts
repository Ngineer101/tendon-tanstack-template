import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "#/lib/mcp/config.server";
import { createMcpServerConnection, getMcpLimit, listMcpServers } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv>(async ({ env, user }) => {
        const [servers, limit] = await Promise.all([
          listMcpServers(env, user.id),
          getMcpLimit(env, user.id),
        ]);
        return Response.json({
          servers,
          limit: Number.isFinite(limit.limit) ? limit.limit : null,
          pro: limit.pro,
          count: servers.length,
        });
      }),

      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const body = (await request.json().catch(() => null)) as {
            name?: string;
            url?: string;
          } | null;
          if (!body?.name || !body?.url) throw new ApiError(400, "Name and URL are required");
          const { server, requiresAuth } = await createMcpServerConnection(env, user.id, {
            name: body.name,
            url: body.url,
          });
          return Response.json({ server, requiresAuth }, { status: 201 });
        },
        { sameOrigin: true },
      ),
    },
  },
});
