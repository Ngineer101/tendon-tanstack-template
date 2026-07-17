import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticatedApiHandler, parseJsonBody } from "#/lib/api";
import { disconnectMcpServer, updateMcpServer, type McpEnv } from "#/lib/mcp/core.server";

const updateSchema = z
  .object({
    name: z.string().trim().max(80).optional(),
    serverUrl: z.string().trim().min(1, "Server URL is required.").max(2_048).optional(),
  })
  .refine((value) => value.name !== undefined || value.serverUrl !== undefined, {
    message: "Provide a name or server URL to update.",
  });

export const Route = createFileRoute("/api/mcp/servers/$serverId")({
  server: {
    handlers: {
      PATCH: authenticatedApiHandler<McpEnv>(
        async ({ env, params, request, user }) => {
          const { serverId } = params;
          const body = await parseJsonBody(request, updateSchema);
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
