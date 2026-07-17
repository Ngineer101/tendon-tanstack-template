import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticatedApiHandler } from "#/lib/api";
import type { McpEnv } from "#/lib/mcp/config.server";
import { deleteMcpServer, updateMcpServer } from "#/lib/mcp/core.server";

const updateSchema = z
  .object({
    name: z.string().max(80).optional(),
    url: z.string().min(1).max(2048).optional(),
  })
  .refine((value) => value.name !== undefined || value.url !== undefined, {
    message: "Nothing to update",
  });

export const Route = createFileRoute("/api/mcp/servers/$id")({
  server: {
    handlers: {
      PATCH: authenticatedApiHandler<McpEnv>(
        async ({ env, origin, request, user, params }) => {
          const parsed = updateSchema.safeParse(await request.json());
          if (!parsed.success) {
            return Response.json({ error: "Nothing to update" }, { status: 400 });
          }
          const result = await updateMcpServer(env, user.id, origin, params.id, parsed.data);
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
      DELETE: authenticatedApiHandler<McpEnv>(
        async ({ env, user, params }) => {
          return Response.json(await deleteMcpServer(env, user.id, params.id));
        },
        { sameOrigin: true },
      ),
    },
  },
});
