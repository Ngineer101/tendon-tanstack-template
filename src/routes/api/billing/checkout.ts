import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import { BILLING_CATALOG } from "#/lib/billing/config";
import type { BillingEnv } from "#/lib/billing/config.server";
import { createCreditsCheckout, createSubscriptionCheckout } from "#/lib/billing/core.server";

export const Route = createFileRoute("/api/billing/checkout")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<BillingEnv>(
        async ({ env, origin, request, user }) => {
          const body = (await request.json()) as { type?: string; item?: string };

          if (
            body.type === "subscription" &&
            typeof body.item === "string" &&
            body.item in BILLING_CATALOG.subscriptionPlans
          ) {
            const url = await createSubscriptionCheckout(
              env,
              user.id,
              body.item as keyof typeof BILLING_CATALOG.subscriptionPlans,
              origin,
            );
            return Response.json({ url });
          }

          if (
            body.type === "credits" &&
            typeof body.item === "string" &&
            body.item in BILLING_CATALOG.creditPacks
          ) {
            const url = await createCreditsCheckout(
              env,
              user.id,
              body.item as keyof typeof BILLING_CATALOG.creditPacks,
              origin,
            );
            return Response.json({ url });
          }

          return Response.json({ error: "Unknown billing item" }, { status: 400 });
        },
        { sameOrigin: true },
      ),
    },
  },
});
