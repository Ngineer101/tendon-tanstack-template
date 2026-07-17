import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { getMcpDashboard, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv>(async ({ env, user }) => {
        return Response.json(await getMcpDashboard(env, user.id));
      }),
    },
  },
});
