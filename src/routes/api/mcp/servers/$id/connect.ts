import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "#/lib/mcp/config.server";
import { beginAuthorization } from "#/lib/mcp/core.server";

export const Route = createFileRoute("/api/mcp/servers/$id/connect")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user, origin }) => {
          const id = new URL(request.url).pathname.split("/").filter(Boolean)[3] ?? "";
          if (!id) throw new ApiError(400, "Missing server id");
          const { authorizationUrl } = await beginAuthorization(env, user.id, id, origin);
          return Response.json({ authorizationUrl });
        },
        { sameOrigin: true },
      ),
    },
  },
});
