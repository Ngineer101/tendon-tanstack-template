import { createFileRoute } from "@tanstack/react-router";

import { getDb } from "#/db";
import { authenticatedApiHandler } from "#/lib/api";
import { hasEntitlement } from "#/lib/billing/core.server";
import type { BillingEnv } from "#/lib/billing/config.server";
import { FREE_MCP_SERVER_LIMIT, type McpServerListResponse } from "#/lib/mcp/config";
import type { McpEnv } from "#/lib/mcp/config.server";
import { createMcpServer, listMcpServers, toPublicMcpServer } from "#/lib/mcp/core.server";

type Env = McpEnv & BillingEnv;

export const Route = createFileRoute("/api/mcp/servers")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<Env>(async ({ env, user }) => {
        const db = getDb(env.DB);
        const [servers, unlimited] = await Promise.all([
          listMcpServers(db, user.id),
          hasEntitlement(env, user.id, "unlimited_mcp_servers"),
        ]);
        const response: McpServerListResponse = {
          servers: servers.map(toPublicMcpServer),
          limit: {
            used: servers.length,
            max: unlimited ? null : FREE_MCP_SERVER_LIMIT,
            plan: unlimited ? "pro_monthly" : "free",
          },
        };
        return Response.json(response);
      }),
      POST: authenticatedApiHandler<Env>(
        async ({ env, request, user }) => {
          const body = (await request.json().catch(() => ({}))) as {
            name?: unknown;
            url?: unknown;
          };
          const unlimited = await hasEntitlement(env, user.id, "unlimited_mcp_servers");
          const server = await createMcpServer(getDb(env.DB), {
            userId: user.id,
            name: body.name,
            url: body.url,
            unlimited,
          });
          return Response.json({ server: toPublicMcpServer(server) }, { status: 201 });
        },
        { sameOrigin: true },
      ),
    },
  },
});
