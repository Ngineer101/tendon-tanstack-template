import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "#/lib/mcp/config.server";
import { deleteMcpServer, editMcpServer, getSafeMcpServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$id")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv>(async ({ env, user, request }) => {
        const id = extractId(request.url);
        const server = await getSafeMcpServer(env, user.id, id);
        return Response.json({ server });
      }),

      PATCH: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const id = extractId(request.url);
          const body = (await request.json().catch(() => null)) as {
            name?: string;
            url?: string;
          } | null;
          const server = await editMcpServer(env, user.id, id, {
            name: body?.name,
            url: body?.url,
          });
          return Response.json({ server });
        },
        { sameOrigin: true },
      ),

      DELETE: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const id = extractId(request.url);
          await deleteMcpServer(env, user.id, id);
          return Response.json({ ok: true });
        },
        { sameOrigin: true },
      ),
    },
  },
});

function extractId(requestUrl: string): string {
  const url = new URL(requestUrl);
  // Path looks like /api/mcp/servers/<id> or /api/mcp/servers/<id>/<action>.
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api","mcp","servers","<id>", maybe action]
  const id = segments[3];
  if (!id) throw new ApiError(400, "Missing server id");
  return id;
}
