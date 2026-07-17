import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "#/lib/mcp/config.server";
import { testMcpServer } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$id/test")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const id = new URL(request.url).pathname.split("/").filter(Boolean)[3] ?? "";
          if (!id) throw new ApiError(400, "Missing server id");
          const result = await testMcpServer(env, user.id, id);
          if (!result.ok) {
            return Response.json({ ok: false, error: result.error }, { status: 502 });
          }
          return Response.json({ ok: true, serverInfo: result.serverInfo });
        },
        { sameOrigin: true },
      ),
    },
  },
});
