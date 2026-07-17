import { purgeExpiredOAuthStates } from "#/lib/mcp/core.server";
import type { QueueMessage } from "./queues";

export async function handleCron(
  event: ScheduledController,
  env: Cloudflare.Env,
  _ctx: ExecutionContext,
) {
  switch (event.cron) {
    case "*/15 * * * *":
      await env.JOBS_QUEUE.send({
        type: "sync-account",
        accountId: "example-account",
      } satisfies QueueMessage);
      // Best-effort cleanup of expired MCP OAuth state rows so they cannot be
      // replayed. Failures here must not block other cron work.
      try {
        await purgeExpiredOAuthStates(env as Parameters<typeof purgeExpiredOAuthStates>[0]);
      } catch (error) {
        console.warn(
          "MCP OAuth state purge failed",
          error instanceof Error ? error.message : error,
        );
      }
      break;

    default:
      console.warn(`Unhandled cron schedule: ${event.cron}`);
  }
}
