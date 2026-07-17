import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { testMcpServerConnection, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/test")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
          if (typeof body?.id !== "string") {
            throw new ApiError(400, "MCP server ID is required");
          }

          return Response.json(await testMcpServerConnection(env, user.id, body.id));
        },
        { sameOrigin: true },
      ),
    },
  },
});
