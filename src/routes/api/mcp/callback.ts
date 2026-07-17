import { createFileRoute } from "@tanstack/react-router";

import { publicApiHandler } from "#/lib/api";
import type { MCPEnv } from "#/lib/mcp/config";
import { completeOAuth } from "#/lib/mcp/core.server";

const POST_MESSAGE_SCRIPT = `<script>
(function(){try{if(window.opener){window.opener.postMessage("mcp-oauth-complete","*")}}catch(e){}})();
</script>`;

const OAUTH_CSS =
  `body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#1a1a1a}` +
  `.container{text-align:center;padding:2rem}` +
  `h1{font-size:1.5rem;margin-bottom:.5rem}` +
  `p{color:#666;font-size:.875rem;max-width:400px;margin:.5rem auto}`;

function oauthHtmlPage(title: string, body: string, status = 200): Response {
  const html = `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title><style>${OAUTH_CSS}</style></head>
<body><div class="container">${body}</div>
${POST_MESSAGE_SCRIPT}
</body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
    status,
  });
}

export const Route = createFileRoute("/api/mcp/callback")({
  server: {
    handlers: {
      GET: publicApiHandler<MCPEnv>(async ({ env, request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          const errorDesc =
            url.searchParams.get("error_description") ?? "OAuth authorization failed";
          return oauthHtmlPage(
            "MCP Connection Failed",
            `<h1>Connection Failed</h1><div style="background:#fee2e2;border:1px solid #fecaca;color:#991b1b;padding:.75rem 1rem;border-radius:.5rem;font-size:.8125rem;margin:1rem 0">${errorDesc}</div><p>You can close this window and try again from the dashboard.</p>`,
          );
        }

        if (!code || !state) {
          return oauthHtmlPage(
            "Invalid Request",
            `<h1>Invalid Request</h1><p>Missing required OAuth parameters. Please try connecting again from the dashboard.</p>`,
            400,
          );
        }

        try {
          await completeOAuth(env, { code, state });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unable to complete MCP connection";
          return oauthHtmlPage(
            "MCP Connection Failed",
            `<h1>Connection Failed</h1><div style="background:#fee2e2;border:1px solid #fecaca;color:#991b1b;padding:.75rem 1rem;border-radius:.5rem;font-size:.8125rem;margin:1rem 0">${message}</div><p>You can close this window and try again from the dashboard.</p>`,
          );
        }

        return oauthHtmlPage(
          "MCP Connected",
          `<div style="display:inline-block;width:48px;height:48px;border-radius:50%;background:#10b981;margin-bottom:.5rem;position:relative"><span style="position:absolute;left:14px;top:18px;width:20px;height:10px;border:solid white;border-width:0 0 3px 3px;transform:rotate(-45deg);display:inline-block"></span></div><h1>Connected</h1><div style="background:#d1fae5;border:1px solid #a7f3d0;color:#065f46;padding:.75rem 1rem;border-radius:.5rem;font-size:.8125rem;margin:1rem 0">Your MCP server has been connected successfully.</div><p>You can close this window. The dashboard will update automatically.</p>`,
        );
      }),
    },
  },
});
