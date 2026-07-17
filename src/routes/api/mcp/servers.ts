import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { MCPEnv } from "#/lib/mcp/config";
import { listServers, createServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<MCPEnv>(async ({ env, user }) => {
        const servers = await listServers(env, user.id);
        return Response.json(servers);
      }),
      POST: authenticatedApiHandler<MCPEnv>(
        async ({ env, request, user }) => {
          const body = (await request.json()) as {
            label?: string;
            serverUrl?: string;
          };

          if (!body.label || !body.serverUrl) {
            return Response.json({ error: "Label and serverUrl are required" }, { status: 400 });
          }

          const result = await createServer(env, user.id, {
            label: body.label,
            serverUrl: body.serverUrl,
          });

          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
