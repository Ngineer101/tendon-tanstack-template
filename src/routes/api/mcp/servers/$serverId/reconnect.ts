import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticatedApiHandler, parseJsonBody } from "#/lib/api";
import { beginMcpOAuth, type McpEnv } from "#/lib/mcp/core.server";

const reconnectSchema = z.object({
  name: z.string().trim().max(80).optional(),
  serverUrl: z.string().trim().min(1, "Server URL is required.").max(2_048),
  scope: z.string().trim().max(512).optional(),
});

export const Route = createFileRoute("/api/mcp/servers/$serverId/reconnect")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, params, request, user }) => {
          const body = await parseJsonBody(request, reconnectSchema);
          const result = await beginMcpOAuth(env, {
            userId: user.id,
            connectionId: params.serverId,
            name: body.name,
            serverUrl: body.serverUrl,
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
