import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { BILLING_CATALOG, type BillingEnv } from "#/lib/billing/config";
import { requireCredits } from "#/lib/billing/core";

export const Route = createFileRoute("/api/billing/consume")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<BillingEnv>(
        async ({ env, request, user }) => {
          const body = (await request.json()) as { action?: string };
          if (!body.action || !(body.action in BILLING_CATALOG.creditCosts)) {
            return Response.json({ error: "Unknown credit action" }, { status: 400 });
          }

          const result = await requireCredits(
            env,
            user.id,
            body.action as keyof typeof BILLING_CATALOG.creditCosts,
          );
          return Response.json(result);
        },
        { sameOrigin: true },
      ),
    },
  },
});
