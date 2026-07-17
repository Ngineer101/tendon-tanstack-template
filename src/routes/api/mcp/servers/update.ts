import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError, readJsonBody } from "#/lib/api-error";
import { updateMcpServer, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/update")({
  server: {
    handlers: {
      PATCH: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const body = await readJsonBody<{
            id?: unknown;
            name?: unknown;
            serverUrl?: unknown;
          }>(request);

          if (
            typeof body?.id !== "string" ||
            body.id.length > 128 ||
            typeof body.name !== "string" ||
            typeof body.serverUrl !== "string"
          ) {
            throw new ApiError(400, "MCP server ID, name, and URL are required");
          }

          return Response.json(
            await updateMcpServer(env, user.id, {
              id: body.id,
              name: body.name,
              serverUrl: body.serverUrl,
            }),
          );
        },
        { sameOrigin: true },
      ),
    },
  },
});
