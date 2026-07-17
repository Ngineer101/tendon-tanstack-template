import { createFileRoute } from "@tanstack/react-router";

import { publicApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "#/lib/mcp/config.server";
import { completeAuthorization } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      // The callback is a top-level browser navigation from the MCP server, so
      // it is not subject to same-origin checks (the request originates from a
      // third-party domain). Authorization state validity is enforced via the
      // encrypted, HMAC-free signed state stored server-side.
      GET: publicApiHandler<McpEnv>(
        async ({ env, request }) => {
          const url = new URL(request.url);
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error") ?? undefined;
          const errorDescription = url.searchParams.get("error_description") ?? undefined;

          const redirectOrigin = `${url.origin}`;
          let target = `${redirectOrigin}/dashboard?mcp=error`;
          try {
            await completeAuthorization(env, {
              code: code ?? "",
              state: state ?? "",
              error,
              errorDescription,
            });
            target = `${redirectOrigin}/dashboard?mcp=connected`;
          } catch (err) {
            const message =
              err instanceof ApiError ? err.message : "Unable to complete authorization";
            target = `${redirectOrigin}/dashboard?mcp=error&reason=${encodeURIComponent(message)}`;
          }
          return new Response(null, {
            status: 302,
            headers: { location: target, "cache-control": "no-store" },
          });
        },
        { fallbackError: { status: 400, message: "Invalid OAuth callback" } },
      ),
    },
  },
});
