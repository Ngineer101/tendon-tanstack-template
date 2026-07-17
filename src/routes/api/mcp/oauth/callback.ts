import { createFileRoute } from "@tanstack/react-router";

import { publicApiHandler } from "#/lib/api";
import { getAuth } from "#/lib/auth";
import { completeMcpOAuth, failMcpOAuth, type McpEnv } from "#/lib/mcp/core.server";

function dashboardRedirect(origin: string, status: "connected" | "error", error?: string) {
  const target = new URL("/dashboard", origin);
  target.searchParams.set("mcp", status);
  if (error) target.searchParams.set("mcp_error", error);
  return Response.redirect(target, 302);
}

export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: publicApiHandler<McpEnv>(async ({ env, origin, request }) => {
        const session = await getAuth(env).api.getSession({ headers: request.headers });
        if (!session) return dashboardRedirect(origin, "error", "session_required");

        const query = new URL(request.url).searchParams;
        const state = query.get("state");
        if (state && state.length > 256) {
          return dashboardRedirect(origin, "error", "invalid_callback");
        }
        if (query.has("error")) {
          if (state) await failMcpOAuth(env, session.user.id, state);
          return dashboardRedirect(origin, "error", "access_denied");
        }
        const code = query.get("code");
        if (!state || !code || code.length > 4_096) {
          return dashboardRedirect(origin, "error", "invalid_callback");
        }

        try {
          await completeMcpOAuth(env, session.user.id, state, code);
          return dashboardRedirect(origin, "connected");
        } catch (error) {
          const code =
            error instanceof Error && "details" in error
              ? ((error as { details?: { code?: string } }).details?.code ?? "oauth_failed")
              : "oauth_failed";
          return dashboardRedirect(origin, "error", code);
        }
      }),
    },
  },
});
