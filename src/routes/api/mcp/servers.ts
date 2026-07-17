import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { BillingEnv } from "#/lib/billing/config.server";
import {
  beginServerConnection,
  createMcpContext,
  listServersWithUsage,
  type McpEnv,
} from "#/lib/mcp/servers.server";

export const Route = createFileRoute("/api/mcp/servers")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv & BillingEnv>(async ({ env, user }) => {
        return Response.json(await listServersWithUsage(createMcpContext(env), user.id));
      }),
      POST: authenticatedApiHandler<McpEnv & BillingEnv>(
        async ({ env, origin, request, user }) => {
          const body = (await request.json()) as { name?: unknown; serverUrl?: unknown };
          const result = await beginServerConnection(createMcpContext(env), user.id, body, origin);
          return Response.json(result, { status: 201 });
        },
        { sameOrigin: true },
      ),
    },
  },
});
