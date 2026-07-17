import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "#/lib/mcp/config.server";
import { completeConnection } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, request, user }) => {
          const url = new URL(request.url);
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          if (!code || !state) throw new ApiError(400, "Missing OAuth callback parameters");

          await completeConnection(env, user.id, { code, state }, origin);

          // Bounce back to the dashboard so the page refreshes its grid.
          const dashboard = new URL("/dashboard?mcp=connected", origin).href;
          return Response.redirect(dashboard, 302);
        },
        { sameOrigin: false },
      ),
    },
  },
});
