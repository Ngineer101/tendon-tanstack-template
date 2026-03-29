import { createFileRoute } from "@tanstack/react-router";
import { getCloudflareEnv } from "#/lib/get-env";
import { getAuth } from "#/lib/auth";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const env = getCloudflareEnv();
        return getAuth(env).handler(request);
      },
      POST: ({ request }) => {
        const env = getCloudflareEnv();
        return getAuth(env).handler(request);
      },
    },
  },
});
