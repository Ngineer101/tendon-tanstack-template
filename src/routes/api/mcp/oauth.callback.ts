import { createFileRoute } from "@tanstack/react-router";

import { getDb } from "#/db";
import { publicApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { getAuth } from "#/lib/auth";
import { getMcpEncryptionKey, type McpEnv } from "#/lib/mcp/config.server";
import { completeMcpAuthorization } from "#/lib/mcp/core.server";

// Browser-facing OAuth redirect target. Every outcome ends in a redirect to a
// fixed internal path — never to anything derived from the request — with a
// short, non-sensitive status message in the search params.
export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: publicApiHandler<McpEnv>(async ({ env, origin, request }) => {
        const dashboard = (params: Record<string, string>) => {
          const url = new URL("/dashboard", origin);
          for (const [name, value] of Object.entries(params)) {
            url.searchParams.set(name, value);
          }
          return Response.redirect(url.toString(), 302);
        };

        const session = await getAuth(env).api.getSession({ headers: request.headers });
        if (!session) {
          return Response.redirect(new URL("/sign-in", origin).toString(), 302);
        }

        const search = new URL(request.url).searchParams;
        const code = search.get("code");
        const state = search.get("state");
        if (search.get("error") || !code || !state) {
          const reason =
            search.get("error") === "access_denied"
              ? "Authorization was declined"
              : "Authorization failed — the provider did not return a valid response";
          return dashboard({ mcp: "error", mcpMessage: reason });
        }

        try {
          const server = await completeMcpAuthorization(getDb(env.DB), getMcpEncryptionKey(env), {
            userId: session.user.id,
            state,
            code,
          });
          if (server.status === "connected") {
            return dashboard({ mcp: "connected", mcpServer: server.id });
          }
          return dashboard({
            mcp: "error",
            mcpMessage: server.lastError ?? "Connected, but the server test failed",
          });
        } catch (error) {
          const message =
            error instanceof ApiError ? error.message : "Authorization failed unexpectedly";
          if (!(error instanceof ApiError)) console.error("MCP OAuth callback failed");
          return dashboard({ mcp: "error", mcpMessage: message.slice(0, 200) });
        }
      }),
    },
  },
});
