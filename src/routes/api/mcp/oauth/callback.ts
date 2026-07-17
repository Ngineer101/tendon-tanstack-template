import { createFileRoute } from "@tanstack/react-router";

import { publicApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/config.server";
import { handleOAuthCallback } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      // The MCP server redirects the user back here after authorization. We
      // exchange the code, store the (encrypted) tokens, then redirect to the
      // dashboard so the user sees the updated grid. Errors are surfaced
      // through the dashboard's query params and never in the URL fragment.
      GET: publicApiHandler<McpEnv>(async ({ env, request, origin }) => {
        const url = new URL(request.url);
        const query = {
          state: url.searchParams.get("state") ?? undefined,
          code: url.searchParams.get("code") ?? undefined,
          error: url.searchParams.get("error") ?? undefined,
          errorDescription: url.searchParams.get("error_description") ?? undefined,
        };

        try {
          await handleOAuthCallback(env, query, origin);
          return dashboardRedirect(origin, { mcp: "connected" });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unable to complete MCP authorization";
          // Sanitize the message before putting it in a URL — never include
          // token values or internal details.
          const safe = message.slice(0, 200).replace(/[\r\n]/g, " ");
          return dashboardRedirect(origin, { mcp: "error", message: safe });
        }
      }),
    },
  },
});

function dashboardRedirect(origin: string, params: Record<string, string>): Response {
  const search = new URLSearchParams(params).toString();
  return Response.redirect(new URL(`/dashboard?${search}`, origin), 302);
}
