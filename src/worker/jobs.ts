import type { QueueMessage } from "./queues";
import type { ExampleWorkflowParams } from "./workflows";

export async function enqueueWelcomeEmail(env: Cloudflare.Env, userId: string) {
  await env.JOBS_QUEUE.send({
    type: "send-welcome-email",
    userId,
  } satisfies QueueMessage);
}

export async function enqueueAccountSync(env: Cloudflare.Env, accountId: string) {
  await env.JOBS_QUEUE.send({
    type: "sync-account",
    accountId,
  } satisfies QueueMessage);
}

export async function startExampleWorkflow(env: Cloudflare.Env, params: ExampleWorkflowParams) {
  return env.EXAMPLE_WORKFLOW.create({
    id: `example:${params.accountId}`,
    params,
  });
}

export async function sendWelcomeEmail(userId: string, _env: Cloudflare.Env) {
  console.log(`Sending welcome email for user ${userId}`);
}

export async function syncAccount(accountId: string, _env: Cloudflare.Env) {
  console.log(`Syncing account ${accountId}`);
}
