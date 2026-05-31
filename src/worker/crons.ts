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
      break;

    default:
      console.warn(`Unhandled cron schedule: ${event.cron}`);
  }
}
