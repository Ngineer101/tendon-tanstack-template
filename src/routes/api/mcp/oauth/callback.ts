import { env } from "cloudflare:workers";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { getAuth } from "#/lib/auth";
import { completeMcpOAuth, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const oauthError = url.searchParams.get("error");

        if (oauthError) {
          throw redirect({
            to: "/dashboard",
            search: {
              mcp: "error" as const,
              message: "MCP authorization was cancelled or denied.",
            },
          });
        }

        if (!state || !code) {
          throw redirect({
            to: "/dashboard",
            search: {
              mcp: "error" as const,
              message: "MCP authorization response was incomplete.",
            },
          });
        }

        const session = await getAuth(env as McpEnv).api.getSession({ headers: request.headers });
        if (!session) {
          throw redirect({
            to: "/sign-in",
            search: { redirect: `/dashboard?mcp=resume` },
          });
        }

        try {
          await completeMcpOAuth(env as McpEnv, { userId: session.user.id, state, code });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unable to finish MCP authorization.";
          throw redirect({
            to: "/dashboard",
            search: { mcp: "error" as const, message },
          });
        }

        throw redirect({
          to: "/dashboard",
          search: { mcp: "connected" as const, message: undefined },
        });
      },
    },
  },
});
