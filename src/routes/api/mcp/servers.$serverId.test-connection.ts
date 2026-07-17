import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { BillingEnv } from "#/lib/billing/config.server";
import { createMcpContext, testServerConnection, type McpEnv } from "#/lib/mcp/servers.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId/test-connection")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv & BillingEnv>(
        async ({ env, params, user }) => {
          const server = await testServerConnection(
            createMcpContext(env),
            user.id,
            params.serverId ?? "",
          );
          return Response.json({ server });
        },
        { sameOrigin: true },
      ),
    },
  },
});
