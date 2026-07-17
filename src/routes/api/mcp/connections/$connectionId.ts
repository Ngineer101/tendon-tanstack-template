import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticatedApiHandler, readJsonBody } from "#/lib/api";
import { disconnectMcpConnection, type McpEnv, updateMcpConnection } from "#/lib/mcp/core.server";

const connectionInput = z.object({
  name: z.string().trim().min(1, "Give this server a name").max(80),
  serverUrl: z.string().trim().min(1, "Enter the MCP server URL").max(2_048),
});

export const Route = createFileRoute("/api/mcp/connections/$connectionId")({
  server: {
    handlers: {
      PATCH: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, request, user }) => {
          const parsed = connectionInput.safeParse(await readJsonBody(request));
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? "Invalid MCP server details" },
              { status: 400 },
            );
          }
          const connectionId = new URL(request.url).pathname.split("/").at(-1)!;
          return Response.json(
            await updateMcpConnection(env, user.id, connectionId, parsed.data, origin),
          );
        },
        { sameOrigin: true },
      ),
      DELETE: authenticatedApiHandler<McpEnv>(
        async ({ env, request, user }) => {
          const connectionId = new URL(request.url).pathname.split("/").at(-1)!;
          await disconnectMcpConnection(env, user.id, connectionId);
          return new Response(null, { status: 204 });
        },
        { sameOrigin: true },
      ),
    },
  },
});
