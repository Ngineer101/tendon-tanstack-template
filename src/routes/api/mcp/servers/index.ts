import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/config.server";
import { connectServer, discover, listServers } from "#/lib/mcp/core.server";
import { shouldAllowLocalhost } from "#/lib/mcp/oauth.server";
import { validateServerUrl } from "#/lib/mcp/ssrf.server";

export const Route = createFileRoute("/api/mcp/servers/")({
  server: {
    handlers: {
      // List the caller's MCP servers. Never returns credentials.
      GET: authenticatedApiHandler<McpEnv>(async ({ env, user }) => {
        return Response.json(await listServers(env, user.id));
      }),

      // Discover OAuth metadata for a URL (dry run) — used to preview the
      // server before starting the OAuth flow.
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user, origin }) => {
          const body = (await request.json()) as {
            action?: "discover" | "connect";
            serverUrl?: string;
            name?: string;
          };

          if (!body.serverUrl || typeof body.serverUrl !== "string") {
            return Response.json({ error: "serverUrl is required" }, { status: 400 });
          }

          const allowLocalhost = shouldAllowLocalhost(env);
          try {
            validateServerUrl(body.serverUrl, { allowLocalhost });
          } catch (error) {
            return Response.json(
              { error: error instanceof Error ? error.message : "Invalid server URL" },
              { status: 400 },
            );
          }

          if (body.action === "connect") {
            const name = typeof body.name === "string" ? body.name : undefined;
            const result = await connectServer(
              env,
              user.id,
              { serverUrl: body.serverUrl, name },
              origin,
            );
            return Response.json(result);
          }

          // Default: discover only.
          const result = await discover(
            env,
            { serverUrl: body.serverUrl, name: body.name },
            origin,
          );
          return Response.json({
            serverUrl: result.validatedUrl,
            name: result.name,
            authorizationEndpoint: result.metadata.authorizationEndpoint,
            tokenEndpoint: result.metadata.tokenEndpoint,
            supportsDynamicRegistration: !!result.metadata.registrationEndpoint,
          });
        },
        { sameOrigin: true },
      ),
    },
  },
});
