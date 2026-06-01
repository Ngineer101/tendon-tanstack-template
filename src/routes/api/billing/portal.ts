import { createFileRoute } from "@tanstack/react-router";

import { authenticatedApiHandler } from "#/lib/api";
import type { BillingEnv } from "#/lib/billing/config.server";
import { createCustomerPortal } from "#/lib/billing/core.server";

export const Route = createFileRoute("/api/billing/portal")({
  server: {
    handlers: {
      POST: authenticatedApiHandler<BillingEnv>(
        async ({ env, origin, user }) => {
          return Response.json({ url: await createCustomerPortal(env, user.id, origin) });
        },
        { sameOrigin: true },
      ),
    },
  },
});
