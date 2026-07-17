import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "#/lib/mcp/config.server";
import { editServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/edit/$serverId")({
  server: {
    handlers: {
      PATCH: authenticatedApiHandler<McpEnv>(
        async ({ env, params, request, user }) => {
          const body = (await request.json().catch(() => null)) as {
            name?: unknown;
            serverUrl?: unknown;
          } | null;
          if (!body) throw new ApiError(400, "Invalid request body");
          const name = typeof body.name === "string" ? body.name : undefined;
          const serverUrl = typeof body.serverUrl === "string" ? body.serverUrl : undefined;
          const updated = await editServer(env, user.id, params.serverId, { name, serverUrl });
          return Response.json({ server: updated });
        },
        { sameOrigin: true },
      ),
    },
  },
});
