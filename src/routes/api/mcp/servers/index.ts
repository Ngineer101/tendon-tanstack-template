import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { hasEntitlement } from "#/lib/billing/core.server";
import type { BillingEnv } from "#/lib/billing/config.server";
import { createMcpServer, getMcpDeps, listMcpServers, type McpEnv } from "#/lib/mcp/core.server";

type Env = McpEnv & BillingEnv;

export const Route = createFileRoute("/api/mcp/servers/")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<Env>(async ({ env, user }) => {
        const unlimited = await hasEntitlement(env, user.id, "unlimited_mcp_servers");
        return Response.json(await listMcpServers(getMcpDeps(env), user.id, unlimited));
      }),
      POST: authenticatedApiHandler<Env>(
        async ({ env, request, user }) => {
          const body = (await request.json()) as { name?: unknown; serverUrl?: unknown };
          if (typeof body.name !== "string" || typeof body.serverUrl !== "string") {
            return Response.json({ error: "Name and server URL are required" }, { status: 400 });
          }

          const unlimited = await hasEntitlement(env, user.id, "unlimited_mcp_servers");
          const result = await createMcpServer(
            getMcpDeps(env),
            user.id,
            { name: body.name, serverUrl: body.serverUrl },
            { unlimited },
          );
          return Response.json(result, { status: 201 });
        },
        { sameOrigin: true },
      ),
    },
  },
});
