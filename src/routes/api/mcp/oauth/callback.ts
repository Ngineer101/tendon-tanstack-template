import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/config.server";
import { handleOauthCallback } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv>(async ({ env, origin, request, user }) => {
        const search = new URL(request.url).searchParams;
        const outcome = await handleOauthCallback(env, user.id, origin, {
          state: searchParams(search, "state"),
          code: searchParams(search, "code"),
          error: searchParams(search, "error"),
        });

        const target = new URL("/dashboard", origin);
        if (outcome.result === "connected") {
          target.searchParams.set("mcp", "connected");
        } else if (outcome.result === "cancelled") {
          target.searchParams.set("mcp", "cancelled");
        } else {
          target.searchParams.set("mcp", "error");
          target.searchParams.set("reason", outcome.reason);
        }
        return new Response(null, { status: 302, headers: { location: target.toString() } });
      }),
    },
  },
});

function searchParams(search: URLSearchParams, key: string): string | undefined {
  return search.get(key) ?? undefined;
}
