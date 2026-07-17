import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticatedApiHandler } from "#/lib/api";
import type { BillingEnv } from "#/lib/billing/config.server";
import type { McpEnv } from "#/lib/mcp/config.server";
import { createMcpServer, listMcpServers } from "#/lib/mcp/core.server";

const createSchema = z.object({
  url: z.string().min(1).max(2048),
  name: z.string().max(80).optional(),
});

export const Route = createFileRoute("/api/mcp/servers/")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv>(async ({ env, user }) => {
        return Response.json({ servers: await listMcpServers(env, user.id) });
      }),
      POST: authenticatedApiHandler<McpEnv & BillingEnv>(
        async ({ env, origin, request, user }) => {
          const parsed = createSchema.safeParse(await request.json());
          if (!parsed.success) {
            return Response.json({ error: "A server URL is required" }, { status: 400 });
          }
          const result = await createMcpServer(env, user.id, origin, parsed.data);
          return Response.json(result, { status: 201 });
        },
        { sameOrigin: true },
      ),
    },
  },
});
