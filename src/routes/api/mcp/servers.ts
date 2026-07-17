import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/config.server";
import { listMcpServers } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv>(async ({ env, user }) => {
        return Response.json(await listMcpServers(env, user.id));
      }),
    },
  },
});
