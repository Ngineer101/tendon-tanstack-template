import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import { previewMcpDiscovery, type McpEnv } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/discover")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ request }) => {
          const body = (await request.json().catch(() => null)) as { serverUrl?: unknown } | null;
          if (typeof body?.serverUrl !== "string") {
            throw new ApiError(400, "MCP server URL is required");
          }

          return Response.json(await previewMcpDiscovery(body.serverUrl));
        },
        { sameOrigin: true },
      ),
    },
  },
});
