import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "#/lib/mcp/config.server";
import { disconnectMcpServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$id/disconnect")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const id = new URL(request.url).pathname.split("/").filter(Boolean)[3] ?? "";
          if (!id) throw new ApiError(400, "Missing server id");
          const server = await disconnectMcpServer(env, user.id, id);
          return Response.json({ server });
        },
        { sameOrigin: true },
      ),
    },
  },
});
