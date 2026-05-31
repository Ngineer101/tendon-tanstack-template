import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { syncAccount } from "./jobs";

export type ExampleWorkflowParams = {
  accountId: string;
};

export class ExampleWorkflow extends WorkflowEntrypoint<Cloudflare.Env, ExampleWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<ExampleWorkflowParams>>, step: WorkflowStep) {
    const accountId = await step.do("load account id", async () => {
      return event.payload.accountId;
    });

    await step.do(
      "sync account",
      {
        retries: {
          limit: 3,
          delay: "10 seconds",
          backoff: "exponential",
        },
      },
      async () => {
        await syncAccount(accountId, this.env);
        return { ok: true };
      },
    );
  }
}
