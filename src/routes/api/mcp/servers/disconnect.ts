import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError, readJsonBody } from "#/lib/api-error";
import { disconnectMcpServer, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/disconnect")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const body = await readJsonBody<{ id?: unknown }>(request);
          if (typeof body?.id !== "string" || body.id.length > 128) {
            throw new ApiError(400, "MCP server ID is required");
          }

          return Response.json(await disconnectMcpServer(env, user.id, body.id));
        },
        { sameOrigin: true },
      ),
    },
  },
});
