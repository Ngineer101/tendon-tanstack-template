import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { beginConnection } from "#/lib/mcp/core.server";
import type { McpEnv } from "#/lib/mcp/config.server";
import { ApiError } from "#/lib/api-error";

export const Route = createFileRoute("/api/mcp/connect")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, request, user }) => {
          const body = (await request.json().catch(() => null)) as {
            name?: unknown;
            serverUrl?: unknown;
          } | null;
          if (!body) throw new ApiError(400, "Invalid request body");
          if (typeof body.name !== "string" || typeof body.serverUrl !== "string") {
            throw new ApiError(400, "Name and serverUrl are required");
          }
          const result = await beginConnection(
            env,
            user.id,
            { name: body.name, serverUrl: body.serverUrl },
            origin,
          );
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
