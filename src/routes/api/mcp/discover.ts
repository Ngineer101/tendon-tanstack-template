import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "#/lib/mcp/config.server";
import { discoverOauthMetadata } from "#/lib/mcp/core.server";
import { validateOutboundUrl } from "#/lib/mcp/url.server";

export const Route = createFileRoute("/api/mcp/discover")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<McpEnv>(
        async ({ env, request }) => {
          const body = (await request.json().catch(() => null)) as { url?: string } | null;
          if (!body?.url) throw new ApiError(400, "Server URL is required");

          const normalized = validateOutboundUrl(body.url, {
            allowInsecureHttp: env.MCP_ALLOW_INSECURE_HTTP === "true",
          });

          let requiresAuth = true;
          let metadata: Awaited<ReturnType<typeof discoverOauthMetadata>> | null = null;
          let discoveryError: string | null = null;
          try {
            metadata = await discoverOauthMetadata(normalized);
            requiresAuth = Boolean(metadata.authorizationEndpoint);
          } catch (error) {
            if (error instanceof ApiError && error.status === 422) {
              requiresAuth = false;
              discoveryError = error.message;
            } else {
              throw error;
            }
          }

          return Response.json({
            url: normalized.url,
            requiresAuth,
            discoveryError,
            metadata,
          });
        },
        { sameOrigin: true },
      ),
    },
  },
});
