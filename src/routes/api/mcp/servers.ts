import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import {
  beginMcpOAuth,
  discoverMcpOAuth,
  listMcpServers,
  type McpEnv,
} from "#/lib/mcp/core.server";

async function readJson<T>(request: Request) {
  return (await request.json().catch(() => ({}))) as Partial<T>;
}

export const Route = createFileRoute("/api/mcp/servers")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv>(async ({ env, user }) => {
        return Response.json(await listMcpServers(env, user.id));
      }),
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, request, user }) => {
          const body = await readJson<{
            name: string;
            serverUrl: string;
            scope: string;
            mode: "discover" | "connect";
          }>(request);

          if (body.mode === "discover") {
            const discovery = await discoverMcpOAuth(String(body.serverUrl ?? ""));
            return Response.json({
              issuer: discovery.issuer,
              authorizationEndpoint: discovery.authorizationEndpoint,
              tokenEndpoint: discovery.tokenEndpoint,
              registrationAvailable: !!discovery.registrationEndpoint,
              scopesSupported: discovery.scopesSupported,
            });
          }

          const result = await beginMcpOAuth(env, {
            userId: user.id,
            name: body.name,
            serverUrl: String(body.serverUrl ?? ""),
            scope: body.scope,
            origin,
          });
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
