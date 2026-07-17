import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { startMcpAuthorization, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/auth/start")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, request, user }) => {
          const body = (await request.json().catch(() => null)) as {
            name?: unknown;
            serverUrl?: unknown;
            scopes?: unknown;
            serverId?: unknown;
          } | null;

          if (typeof body?.name !== "string" || typeof body.serverUrl !== "string") {
            throw new ApiError(400, "MCP server name and URL are required");
          }
          if (body.scopes !== undefined && typeof body.scopes !== "string") {
            throw new ApiError(400, "OAuth scopes must be a string");
          }
          if (body.serverId !== undefined && typeof body.serverId !== "string") {
            throw new ApiError(400, "MCP server ID must be a string");
          }

          return Response.json(
            await startMcpAuthorization(env, user.id, {
              name: body.name,
              serverUrl: body.serverUrl,
              scopes: body.scopes,
              serverId: body.serverId,
              origin,
            }),
          );
        },
        { sameOrigin: true },
      ),
    },
  },
});
