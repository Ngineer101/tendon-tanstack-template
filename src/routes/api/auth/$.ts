import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { getAuth } from "#/lib/auth";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => {
        return getAuth(env as Cloudflare.Env).handler(request);
      },
      POST: ({ request }) => {
        return getAuth(env as Cloudflare.Env).handler(request);
      },
    },
  },
});
