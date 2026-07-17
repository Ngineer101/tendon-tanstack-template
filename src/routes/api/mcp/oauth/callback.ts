import { createFileRoute } from "@tanstack/react-router";

import { publicApiHandler } from "#/lib/api";
import { getAuth } from "#/lib/auth";
import type { McpApiEnv } from "#/lib/mcp/config.server";
import { abandonOAuth, completeOAuth } from "#/lib/mcp/core.server";

function redirectTo(path: string) {
  // Redirect targets are always app-relative; nothing user-controlled is
  // reflected into the Location header.
  return new Response(null, { status: 303, headers: { location: path } });
}

export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: publicApiHandler<McpApiEnv>(async ({ env, origin, request }) => {
        const session = await getAuth(env).api.getSession({ headers: request.headers });
        if (!session) {
          return redirectTo("/sign-in?redirect=/dashboard");
        }

        const url = new URL(request.url);
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const providerError = url.searchParams.get("error");

        if (providerError) {
          if (state) {
            await abandonOAuth(
              env,
              session.user.id,
              state,
              providerError === "access_denied"
                ? "Authorization was denied or cancelled"
                : "The authorization server returned an error",
            );
          }
          return redirectTo("/dashboard?mcp=denied");
        }

        if (!state || !code) {
          return redirectTo("/dashboard?mcp=error");
        }

        try {
          await completeOAuth(env, session.user.id, { state, code }, origin);
          return redirectTo("/dashboard?mcp=connected");
        } catch {
          // Details were already recorded on the server row (lastError); the
          // dashboard surfaces them on the affected card.
          return redirectTo("/dashboard?mcp=error");
        }
      }),
    },
  },
});
