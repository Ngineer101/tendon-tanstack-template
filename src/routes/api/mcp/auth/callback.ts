import { createFileRoute } from "@tanstack/react-router";

import { getAuth } from "#/lib/auth";
import { ApiError } from "#/lib/api-error";
import { completeMcpAuthorization, type McpEnv } from "#/lib/mcp/core.server";
import { env } from "cloudflare:workers";

function dashboardRedirect(request: Request, status: "connected" | "error", message?: string) {
  const url = new URL("/dashboard", new URL(request.url).origin);
  url.searchParams.set("mcp", status);
  if (message) url.searchParams.set("message", message);
  return Response.redirect(url.toString(), 302);
}

export const Route = createFileRoute("/api/mcp/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const session = await getAuth(env).api.getSession({ headers: request.headers });
        if (!session) {
          return dashboardRedirect(
            request,
            "error",
            "Sign in again to finish connecting your MCP server.",
          );
        }

        const error = url.searchParams.get("error");
        if (error) {
          return dashboardRedirect(request, "error", "The MCP server declined authorization.");
        }

        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (!state || !code) {
          return dashboardRedirect(
            request,
            "error",
            "The MCP server callback was missing required data.",
          );
        }

        try {
          await completeMcpAuthorization(env as McpEnv, session.user.id, {
            state,
            code,
            redirectUri: new URL("/api/mcp/auth/callback", url.origin).toString(),
          });
          return dashboardRedirect(request, "connected");
        } catch (reason) {
          const message =
            reason instanceof ApiError
              ? reason.message
              : "Unable to finish connecting your MCP server.";
          return dashboardRedirect(request, "error", message);
        }
      },
    },
  },
});
