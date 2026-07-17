import { createFileRoute } from "@tanstack/react-router";

import { publicApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { getAuth } from "#/lib/auth";
import type { BillingEnv } from "#/lib/billing/config.server";
import { completeOauthCallback, createMcpContext, type McpEnv } from "#/lib/mcp/servers.server";

// Browser redirect target for the MCP OAuth flow. Always sends the user back
// to the dashboard; the outcome travels in query params. The redirect target
// is a fixed same-origin path, never attacker-controlled.
export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: publicApiHandler<McpEnv & BillingEnv>(async ({ env, origin, request }) => {
        const dashboard = new URL("/dashboard", origin);

        const session = await getAuth(env).api.getSession({ headers: request.headers });
        if (!session) {
          // Not signed in (e.g. session expired mid-flow): back to sign-in.
          return Response.redirect(new URL("/sign-in", origin).toString(), 302);
        }

        const url = new URL(request.url);
        try {
          const server = await completeOauthCallback(
            createMcpContext(env),
            session.user.id,
            {
              state: url.searchParams.get("state"),
              code: url.searchParams.get("code"),
              error: url.searchParams.get("error"),
            },
            origin,
          );
          dashboard.searchParams.set("mcp", server.status === "connected" ? "connected" : "error");
          dashboard.searchParams.set("mcpName", server.name);
          if (server.status !== "connected" && server.lastError) {
            dashboard.searchParams.set("mcpDetail", server.lastError);
          }
        } catch (error) {
          dashboard.searchParams.set("mcp", "error");
          dashboard.searchParams.set(
            "mcpDetail",
            error instanceof ApiError ? error.message : "Authorization could not be completed",
          );
          if (!(error instanceof ApiError)) {
            // Unexpected failure: log the class of error, never query params or
            // token material.
            console.error("MCP OAuth callback failed", error instanceof Error ? error.name : "");
          }
        }

        return Response.redirect(dashboard.toString(), 302);
      }),
    },
  },
});
