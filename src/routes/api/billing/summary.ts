import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { BillingEnv } from "#/lib/billing/config";
import { getBillingSummary } from "#/lib/billing/core";

export const Route = createFileRoute("/api/billing/summary")({
  server: {
    handlers: {
      GET: authenticatedApiHandler<BillingEnv>(async ({ env, user }) => {
        return Response.json(await getBillingSummary(env, user.id));
      }),
    },
  },
});
