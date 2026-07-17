import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { MCPEnv } from "#/lib/mcp/core.server";
import {
  getMCPServer,
  updateMCPServer,
  deleteMCPServer,
  disconnectMCPServer,
} from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/$id")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<MCPEnv>(async ({ env, user, request }) => {
        const url = new URL(request.url);
        const parts = url.pathname.split("/");
        const id = parts[parts.length - 1];
        if (!id) return Response.json({ error: "Missing server ID" }, { status: 400 });
        return Response.json(await getMCPServer(env, user.id, id));
      }),
      PUT: authenticatedApiHandler<MCPEnv>(
        async ({ env, request, user }) => {
          const url = new URL(request.url);
          const parts = url.pathname.split("/");
          const id = parts[parts.length - 1];
          if (!id) return Response.json({ error: "Missing server ID" }, { status: 400 });

          const body = (await request.json()) as {
            name?: string;
            serverUrl?: string;
            disconnect?: boolean;
          };

          if (body.disconnect) {
            const server = await disconnectMCPServer(env, user.id, id);
            return Response.json(server);
          }

          const server = await updateMCPServer(env, user.id, id, {
            name: body.name,
            serverUrl: body.serverUrl,
          });
          return Response.json(server);
        },
        { sameOrigin: true },
      ),
      DELETE: authenticatedApiHandler<MCPEnv>(
        async ({ env, request, user }) => {
          const url = new URL(request.url);
          const parts = url.pathname.split("/");
          const id = parts[parts.length - 1];
          if (!id) return Response.json({ error: "Missing server ID" }, { status: 400 });

          const result = await deleteMCPServer(env, user.id, id);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
