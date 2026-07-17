import { createFileRoute } from "@tanstack/react-router";

import { ApiError } from "#/lib/api-error";
import { publicApiHandler } from "#/lib/api";
import { getAuth } from "#/lib/auth";
import type { McpCoreEnv } from "#/lib/mcp/core.server";
import { completeOAuthCallback } from "#/lib/mcp/core.server";

/**
 * Redirect target for MCP OAuth authorization flows.
 *
 * This endpoint never renders tokens or errors as JSON: it always 302s back
 * to the dashboard with a small status param. Messages placed in the URL come
 * from our own user-safe ApiError messages and are additionally truncated and
 * stripped of control characters; raw upstream errors (which may echo request
 * material) are never propagated.
 */
function dashboardRedirect(origin: string, params: Record<string, string>) {
  const url = new URL("/dashboard", origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value.replace(/[\r\n<>"]/g, "").slice(0, 140));
  }
  return Response.redirect(url.toString(), 302);
}

export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: publicApiHandler<McpCoreEnv>(async ({ env, origin, request }) => {
        const session = await getAuth(env).api.getSession({ headers: request.headers });
        if (!session) {
          const signIn = new URL("/sign-in", origin);
          signIn.searchParams.set("redirect", request.url);
          return Response.redirect(signIn.toString(), 302);
        }

        const url = new URL(request.url);
        const errorParam = url.searchParams.get("error");
        if (errorParam) {
          return dashboardRedirect(origin, {
            mcp: "error",
            message: "The authorization server declined the request. Please try again.",
          });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          return dashboardRedirect(origin, {
            mcp: "error",
            message: "The authorization response was incomplete. Please try again.",
          });
        }

        try {
          await completeOAuthCallback(env, session.user.id, { code, state });
          return dashboardRedirect(origin, { mcp: "connected" });
        } catch (error) {
          const message =
            error instanceof ApiError
              ? error.message
              : "Could not finish connecting the server. Please try again.";
          if (!(error instanceof ApiError)) {
            // Log hygiene: never log the callback URL (it carries the code).
            console.error(
              "MCP OAuth callback failed:",
              error instanceof Error ? error.name : "error",
            );
          }
          return dashboardRedirect(origin, { mcp: "error", message });
        }
      }),
    },
  },
});
