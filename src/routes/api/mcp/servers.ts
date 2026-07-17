import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticatedApiHandler, parseJsonBody } from "#/lib/api";
import {
  beginMcpOAuth,
  discoverMcpOAuth,
  listMcpServers,
  type McpEnv,
} from "#/lib/mcp/core.server";

const requestSchema = z.object({
  name: z.string().trim().max(80).optional(),
  serverUrl: z.string().trim().min(1, "Server URL is required.").max(2_048),
  scope: z.string().trim().max(512).optional(),
  mode: z.enum(["discover", "connect"]),
});

export const Route = createFileRoute("/api/mcp/servers")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv>(async ({ env, user }) => {
        return Response.json(await listMcpServers(env, user.id));
      }),
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, request, user }) => {
          const body = await parseJsonBody(request, requestSchema);

          if (body.mode === "discover") {
            const discovery = await discoverMcpOAuth(body.serverUrl);
            return Response.json({
              issuer: discovery.issuer,
              authorizationEndpoint: discovery.authorizationEndpoint,
              tokenEndpoint: discovery.tokenEndpoint,
              resource: discovery.resource,
              registrationAvailable: !!discovery.registrationEndpoint,
              scopesSupported: discovery.scopesSupported,
            });
          }

          const result = await beginMcpOAuth(env, {
            userId: user.id,
            name: body.name,
            serverUrl: body.serverUrl,
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
