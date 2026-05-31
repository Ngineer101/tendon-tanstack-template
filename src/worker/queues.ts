import { sendWelcomeEmail, syncAccount } from "./jobs";

export type QueueMessage =
  | { type: "send-welcome-email"; userId: string }
  | { type: "sync-account"; accountId: string };

export async function handleQueue(
  batch: MessageBatch<QueueMessage>,
  env: Cloudflare.Env,
  _ctx: ExecutionContext,
) {
  for (const message of batch.messages) {
    switch (message.body.type) {
      case "send-welcome-email":
        await sendWelcomeEmail(message.body.userId, env);
        break;

      case "sync-account":
        await syncAccount(message.body.accountId, env);
        break;

      default:
        message.body satisfies never;
    }
  }
}
