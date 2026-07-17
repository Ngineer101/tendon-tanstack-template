import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { MCPEnv } from "#/lib/mcp/config";
import { getServer, updateServer, deleteServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$id")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<MCPEnv>(async ({ env, user, request }) => {
        const url = new URL(request.url);
        const id = url.pathname.split("/").pop();
        if (!id) {
          return Response.json({ error: "Server ID is required" }, { status: 400 });
        }
        const server = await getServer(env, user.id, id);
        return Response.json({
          id: server.id,
          label: server.label,
          serverUrl: server.serverUrl,
          authStatus: server.authStatus,
          lastTestedAt: server.lastTestedAt?.toISOString() ?? null,
          lastError: server.lastError,
          createdAt: server.createdAt.toISOString(),
        });
      }),
      PATCH: authenticatedApiHandler<MCPEnv>(
        async ({ env, request, user }) => {
          const url = new URL(request.url);
          const id = url.pathname.split("/").pop();
          if (!id) {
            return Response.json({ error: "Server ID is required" }, { status: 400 });
          }

          const body = (await request.json()) as {
            label?: string;
            serverUrl?: string;
          };

          await updateServer(env, user.id, id, body);
          return Response.json({ success: true });
        },
        { sameOrigin: true },
      ),
      DELETE: authenticatedApiHandler<MCPEnv>(
        async ({ env, request, user }) => {
          const url = new URL(request.url);
          const id = url.pathname.split("/").pop();
          if (!id) {
            return Response.json({ error: "Server ID is required" }, { status: 400 });
          }

          await deleteServer(env, user.id, id);
          return Response.json({ success: true });
        },
        { sameOrigin: true },
      ),
    },
  },
});
