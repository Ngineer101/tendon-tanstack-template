import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { BillingEnv } from "#/lib/billing/config.server";
import {
  createMcpContext,
  disconnectServer,
  updateServerDetails,
  type McpEnv,
} from "#/lib/mcp/servers.server";

export const Route = createFileRoute("/api/mcp/servers/$serverId")({
  server: {
    handlers: {
      PATCH: authenticatedApiHandler<McpEnv & BillingEnv>(
        async ({ env, origin, params, request, user }) => {
          const body = (await request.json()) as { name?: unknown; serverUrl?: unknown };
          const result = await updateServerDetails(
            createMcpContext(env),
            user.id,
            params.serverId ?? "",
            body,
            origin,
          );
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
      DELETE: authenticatedApiHandler<McpEnv & BillingEnv>(
        async ({ env, params, user }) => {
          await disconnectServer(createMcpContext(env), user.id, params.serverId ?? "");
          return Response.json({ ok: true });
        },
        { sameOrigin: true },
      ),
    },
  },
});
