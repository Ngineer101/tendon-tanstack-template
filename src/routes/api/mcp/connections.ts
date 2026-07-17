import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticatedApiHandler, readJsonBody } from "#/lib/api";
import { createMcpConnection, listMcpConnections, type McpEnv } from "#/lib/mcp/core.server";

const connectionInput = z.object({
  name: z.string().trim().min(1, "Give this server a name").max(80),
  serverUrl: z.string().trim().min(1, "Enter the MCP server URL").max(2_048),
});

export const Route = createFileRoute("/api/mcp/connections")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<McpEnv>(async ({ env, user }) => {
        return Response.json(await listMcpConnections(env, user.id));
      }),
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, request, user }) => {
          const parsed = connectionInput.safeParse(await readJsonBody(request));
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? "Invalid MCP server details" },
              { status: 400 },
            );
          }
          return Response.json(await createMcpConnection(env, user.id, parsed.data, origin), {
            status: 201,
          });
        },
        { sameOrigin: true },
      ),
    },
  },
});
