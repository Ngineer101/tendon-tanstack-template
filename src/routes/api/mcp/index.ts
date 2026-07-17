import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { MCPEnv } from "#/lib/mcp/core.server";
import { listMCPSevers, createMCPServer, getBillingLimitInfo } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<MCPEnv>(async ({ env, user }) => {
        const servers = await listMCPSevers(env, user.id);
        const limit = await getBillingLimitInfo(env, user.id);
        return Response.json({ servers, limit });
      }),
      POST: authenticatedApiHandler<MCPEnv>(
        async ({ env, request, user }) => {
          const body = (await request.json()) as { name?: string; serverUrl?: string };

          if (typeof body.name !== "string" || typeof body.serverUrl !== "string") {
            return Response.json({ error: "Name and server URL are required" }, { status: 400 });
          }

          const server = await createMCPServer(env, user.id, {
            name: body.name,
            serverUrl: body.serverUrl,
          });

          return Response.json(server, { status: 201 });
        },
        { sameOrigin: true },
      ),
    },
  },
});
