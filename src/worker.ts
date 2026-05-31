import app from "@tanstack/react-start/server-entry";

import { handleCron } from "./worker/crons";
import { handleQueue } from "./worker/queues";
import type { QueueMessage } from "./worker/queues";

export { ExampleWorkflow } from "./worker/workflows";

export default {
  fetch(request, _env, _ctx) {
    return app.fetch(request);
  },

  queue(batch, env, ctx) {
    return handleQueue(batch as MessageBatch<QueueMessage>, env, ctx);
  },

  scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(event, env, ctx));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
