import { createFileRoute } from "@tanstack/react-router";

import { publicApiHandler } from "#/lib/api";

export const Route = createFileRoute("/api/mcp/oauth/client-metadata")({
  server: {
    handlers: {
      GET: publicApiHandler(({ origin }) => {
        const clientId = `${origin}/api/mcp/oauth/client-metadata`;
        return Response.json({
          client_id: clientId,
          client_name: "Tendon MCP Client",
          client_uri: origin,
          redirect_uris: [`${origin}/api/mcp/oauth/callback`],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
      }),
    },
  },
});
