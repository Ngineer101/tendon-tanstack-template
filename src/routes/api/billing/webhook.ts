import { createFileRoute } from "@tanstack/react-router";

import { publicApiHandler } from "#/lib/api";
import type { BillingEnv } from "#/lib/billing/config";
import { handleStripeWebhook } from "#/lib/billing/core";

export const Route = createFileRoute("/api/billing/webhook")({
  server: {
    handlers: {
      POST: publicApiHandler<BillingEnv>(
        async ({ env, request }) => {
          await handleStripeWebhook(env, request);
          return Response.json({ received: true });
        },
        { fallbackError: { status: 400, message: "Invalid webhook" } },
      ),
    },
  },
});
