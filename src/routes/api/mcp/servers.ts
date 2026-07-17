import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpApiEnv } from "#/lib/mcp/config.server";
import { createServer, listMcpServers } from "#/lib/mcp/core.server";

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Invalid request body");
  }
}

export const Route = createFileRoute("/api/mcp/servers")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpApiEnv>(async ({ env, user }) => {
        return Response.json(await listMcpServers(env, user.id));
      }),

      POST: authenticatedApiHandler<McpApiEnv>(
        async ({ env, origin, request, user }) => {
          const body = await parseJsonBody(request);
          if (typeof body.name !== "string" || typeof body.url !== "string") {
            throw new ApiError(400, "Both a name and a URL are required");
          }

          const result = await createServer(
            env,
            user.id,
            { name: body.name, url: body.url },
            origin,
          );
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
