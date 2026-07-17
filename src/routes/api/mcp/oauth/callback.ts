import { createFileRoute } from "@tanstack/react-router";
import { publicApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/core.server";
import { handleMcpOAuthCallback } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: publicApiHandler<McpEnv>(async ({ env: handlerEnv, request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const serverId = url.searchParams.get("server_id");

        if (!code || !state || !serverId) {
          return new Response("Missing required OAuth parameters", { status: 400 });
        }

        try {
          await handleMcpOAuthCallback(handlerEnv, serverId, code, state);
        } catch {
          const redirectUrl = new URL("/dashboard", url.origin);
          redirectUrl.searchParams.set("mcp_oauth", "error");
          return Response.redirect(redirectUrl.toString(), 302);
        }

        const redirectUrl = new URL("/dashboard", url.origin);
        redirectUrl.searchParams.set("mcp_oauth", "success");
        return Response.redirect(redirectUrl.toString(), 302);
      }),
    },
  },
});
