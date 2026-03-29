import { getStartContext } from "@tanstack/start-storage-context";

/**
 * Returns the Cloudflare env bindings from inside any TanStack Start server
 * route handler or server function.
 *
 * How it works: src/server.ts passes the CF env as `requestOpts.context` to
 * createStartHandler. TanStack Start stores it in a server-side, per-request
 * slot (Node.js AsyncLocalStorage from node:async_hooks — completely unrelated
 * to browser localStorage). It never leaves the server process; secrets are safe.
 */
export function getCloudflareEnv(): Cloudflare.Env {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = (getStartContext() as any)?.contextAfterGlobalMiddlewares as
    | Cloudflare.Env
    | undefined;
  if (!env) {
    throw new Error("Cloudflare env not available");
  }
  return env;
}
