import type { QueueMessage } from "./queues";
import { deleteExpiredMcpOauthSessions } from "#/lib/mcp/core.server";

export async function handleCron(
  event: ScheduledController,
  env: Cloudflare.Env,
  _ctx: ExecutionContext,
) {
  switch (event.cron) {
    case "*/15 * * * *":
      await Promise.all([
        env.JOBS_QUEUE.send({
          type: "sync-account",
          accountId: "example-account",
        } satisfies QueueMessage),
        deleteExpiredMcpOauthSessions(env),
      ]);
      break;

    default:
      console.warn(`Unhandled cron schedule: ${event.cron}`);
  }
}
