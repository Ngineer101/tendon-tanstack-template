import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpApiEnv } from "#/lib/mcp/config.server";
import { deleteServer, updateServer } from "#/lib/mcp/core.server";

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Invalid request body");
  }
}

export const Route = createFileRoute("/api/mcp/servers/$serverId")({
  server: {
    handlers: {
      PATCH: authenticatedApiHandler<McpApiEnv>(
        async ({ env, params, request, user }) => {
          const body = await parseJsonBody(request);
          if (
            (body.name !== undefined && typeof body.name !== "string") ||
            (body.url !== undefined && typeof body.url !== "string") ||
            (body.name === undefined && body.url === undefined)
          ) {
            throw new ApiError(400, "Provide a name or a URL to update");
          }

          const server = await updateServer(env, user.id, params.serverId, {
            name: body.name as string | undefined,
            url: body.url as string | undefined,
          });
          return Response.json({ server });
        },
        { sameOrigin: true },
      ),

      DELETE: authenticatedApiHandler<McpApiEnv>(
        async ({ env, params, user }) => {
          await deleteServer(env, user.id, params.serverId);
          return Response.json({ ok: true });
        },
        { sameOrigin: true },
      ),
    },
  },
});
