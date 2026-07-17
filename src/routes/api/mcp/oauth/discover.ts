import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { MCPEnv } from "#/lib/mcp/core.server";
import { discoverOAuth } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/oauth/discover")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<MCPEnv>(
        async ({ request }) => {
          const body = (await request.json()) as { serverUrl?: string };
          if (typeof body.serverUrl !== "string") {
            return Response.json({ error: "Server URL is required" }, { status: 400 });
          }

          const metadata = await discoverOAuth(body.serverUrl);
          return Response.json(metadata);
        },
        { sameOrigin: true },
      ),
    },
  },
});
