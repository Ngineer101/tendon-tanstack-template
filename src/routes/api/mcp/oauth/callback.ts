import { createFileRoute } from "@tanstack/react-router";

import { publicApiHandler } from "#/lib/api";
import type { MCPEnv } from "#/lib/mcp/core.server";
import { completeOAuth } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: publicApiHandler<MCPEnv>(async ({ env, request, origin: requestOrigin }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          const description = url.searchParams.get("error_description") ?? "";
          return Response.redirect(
            `${url.origin}/dashboard?mcp_error=${encodeURIComponent(description || error)}`,
            302,
          );
        }

        if (!code || !state) {
          return Response.redirect(
            `${url.origin}/dashboard?mcp_error=${encodeURIComponent("Missing OAuth parameters")}`,
            302,
          );
        }

        try {
          await completeOAuth(env, code, state, requestOrigin);
          return Response.redirect(`${url.origin}/dashboard?mcp_connected=1`, 302);
        } catch (err) {
          const message = err instanceof Error ? err.message : "OAuth connection failed";
          return Response.redirect(
            `${url.origin}/dashboard?mcp_error=${encodeURIComponent(message)}`,
            302,
          );
        }
      }),
    },
  },
});
