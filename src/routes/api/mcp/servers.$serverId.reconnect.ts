import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { BillingEnv } from "#/lib/billing/config.server";
import { createMcpContext, startReconnect, type McpEnv } from "#/lib/mcp/servers.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/reconnect")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv & BillingEnv>(
        async ({ env, origin, params, user }) => {
          const result = await startReconnect(
            createMcpContext(env),
            user.id,
            params.serverId ?? "",
            origin,
          );
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
