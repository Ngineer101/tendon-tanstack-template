import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { ApiError } from "#/lib/api-error";
import { getAuth } from "#/lib/auth";
import { MCP_ERROR_CODES } from "#/lib/mcp/config";
import { completeAuthorization, getMcpDeps, type McpEnv } from "#/lib/mcp/core.server";

// Browser-facing OAuth redirect target. Always redirects back to the dashboard
// with enumerated result codes only — never echoes provider-supplied strings or
// redirects off-origin.

type CallbackOutcome =
  | { ok: true; serverId: string }
  | { ok: false; code: "access_denied" | "oauth_failed" | "state_invalid" | "callback_failed" };

async function handleCallback(request: Request): Promise<CallbackOutcome> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const providerError = url.searchParams.get("error");

  if (providerError) {
    return {
      ok: false,
      code: providerError === "access_denied" ? "access_denied" : "oauth_failed",
    };
  }
  if (!state || !code) {
    return { ok: false, code: "oauth_failed" };
  }

  const session = await getAuth(env as Cloudflare.Env).api.getSession({
    headers: request.headers,
  });
  if (!session) {
    throw new ApiError(401, "Unauthorized");
  }

  try {
    const result = await completeAuthorization(getMcpDeps(env as McpEnv), session.user.id, {
      state,
      code,
    });
    return { ok: true, serverId: result.serverId };
  } catch (error) {
    if (error instanceof ApiError && error.details?.code === MCP_ERROR_CODES.oauth_state_invalid) {
      return { ok: false, code: "state_invalid" };
    }
    // Log only our own error message; token responses are never included in it.
    console.error(
      "MCP OAuth callback failed:",
      error instanceof ApiError ? error.message : "unexpected error",
    );
    return { ok: false, code: "callback_failed" };
  }
}

export const Route = createFileRoute("/api/mcp/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        let outcome: CallbackOutcome;
        try {
          outcome = await handleCallback(request);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            return Response.redirect(`${origin}/sign-in`, 303);
          }
          console.error("MCP OAuth callback failed unexpectedly");
          outcome = { ok: false, code: "callback_failed" };
        }

        const target = new URL("/dashboard", origin);
        if (outcome.ok) {
          target.searchParams.set("mcp", "connected");
          target.searchParams.set("mcp_server", outcome.serverId);
        } else {
          target.searchParams.set("mcp_error", outcome.code);
        }
        return Response.redirect(target.toString(), 303);
      },
    },
  },
});
