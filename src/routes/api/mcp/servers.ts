import { createFileRoute } from "@tanstack/react-router";
import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/core.server";
import { listMcpServers, createMcpServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv>(async ({ env, user }) => {
        const servers = await listMcpServers(env, user.id);
        return Response.json(servers);
      }),
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const body = (await request.json()) as { label?: string; url?: string };
          if (!body.label || !body.url) {
            return Response.json({ error: "Label and URL are required" }, { status: 400 });
          }
          const server = await createMcpServer(env, user.id, {
            label: body.label,
            url: body.url,
          });
          return Response.json(server, { status: 201 });
        },
        { sameOrigin: true },
      ),
    },
  },
});
