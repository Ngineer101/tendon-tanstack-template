import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "#/lib/mcp/config.server";
import {
  deleteServer,
  disconnectServer,
  editServer,
  reconnectServer,
  testServer,
} from "#/lib/mcp/core.server";

// Extract `/api/mcp/servers/<id>` from the request URL. We do this rather
// than relying on route params because the server handler API only passes the
// request, and deriving the id here keeps the validation explicit.
function serverIdFrom(request: Request): string {
  const pathname = new URL(request.url).pathname.replace(/\/$/, "");
  const id = pathname.split("/").pop();
  if (!id) throw new ApiError(400, "Invalid server id");
  return decodeURIComponent(id);
}

export const Route = createFileRoute("/api/mcp/servers/$id")({
  server: {
    handlers: {
      // Edit (rename and/or change URL — URL change resets the connection).
      PATCH: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user, origin }) => {
          const body = (await request.json()) as { name?: string; serverUrl?: string };
          const result = await editServer(env, user.id, serverIdFrom(request), body, origin);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),

      // Disconnect (wipe credentials) or delete entirely.
      DELETE: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const id = serverIdFrom(request);
          const url = new URL(request.url);
          if (url.searchParams.get("purge") === "true") {
            await deleteServer(env, user.id, id);
            return Response.json({ deleted: true });
          }
          const result = await disconnectServer(env, user.id, id);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),

      // Test the saved connection.
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, user, origin, request }) => {
          const result = await testServer(env, user.id, serverIdFrom(request), origin);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),

      // Reconnect: start a fresh OAuth flow against an existing server.
      PUT: authenticatedApiHandler<McpEnv>(
        async ({ env, user, origin, request }) => {
          const result = await reconnectServer(env, user.id, serverIdFrom(request), origin);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
