import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/config.server";
import { disconnectServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/disconnect/$serverId")({
  server: {
    handlers: {
      DELETE: authenticatedApiHandler<McpEnv>(
        async ({ env, params, user }) => {
          await disconnectServer(env, user.id, params.serverId);
          return Response.json({ ok: true });
        },
        { sameOrigin: true },
      ),
    },
  },
});
