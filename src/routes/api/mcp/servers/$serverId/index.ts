import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { deleteMcpServer, getMcpDeps, updateMcpServer, type McpEnv } from "#/lib/mcp/core.server";

function getServerId(params: Record<string, string>): string {
  const serverId = params.serverId;
  if (!serverId) throw new ApiError(400, "Missing server id");
  return serverId;
}

export const Route = createFileRoute("/api/mcp/servers/$serverId/")({
  server: {
    handlers: {
      PATCH: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user, params }) => {
          const body = (await request.json()) as { name?: unknown; serverUrl?: unknown };
          const patch: { name?: string; serverUrl?: string } = {};
          if (body.name !== undefined) {
            if (typeof body.name !== "string") {
              return Response.json({ error: "Name must be a string" }, { status: 400 });
            }
            patch.name = body.name;
          }
          if (body.serverUrl !== undefined) {
            if (typeof body.serverUrl !== "string") {
              return Response.json({ error: "Server URL must be a string" }, { status: 400 });
            }
            patch.serverUrl = body.serverUrl;
          }
          if (patch.name === undefined && patch.serverUrl === undefined) {
            return Response.json({ error: "Nothing to update" }, { status: 400 });
          }

          const result = await updateMcpServer(
            getMcpDeps(env),
            user.id,
            getServerId(params),
            patch,
          );
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
      DELETE: authenticatedApiHandler<McpEnv>(
        async ({ env, user, params }) => {
          await deleteMcpServer(getMcpDeps(env), user.id, getServerId(params));
          return Response.json({ ok: true });
        },
        { sameOrigin: true },
      ),
    },
  },
});
