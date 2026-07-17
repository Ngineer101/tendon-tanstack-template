export const BILLING_CATALOG = {
  subscriptionPlans: {
    pro_monthly: {
      name: "Pro",
      description: "Unlock the premium dashboard with a fixed monthly subscription.",
      priceEnv: "STRIPE_PRO_MONTHLY_PRICE_ID",
      displayPrice: "$20",
      interval: "month",
      entitlements: ["premium_dashboard", "unlimited_mcp_servers"],
    },
  },
  creditPacks: {
    credits_1000: {
      name: "Starter credits",
      credits: 1_000,
      priceEnv: "STRIPE_CREDITS_1000_PRICE_ID",
      displayPrice: "$10",
    },
    credits_5000: {
      name: "Growth credits",
      credits: 5_000,
      priceEnv: "STRIPE_CREDITS_5000_PRICE_ID",
      displayPrice: "$45",
    },
    credits_20000: {
      name: "Scale credits",
      credits: 20_000,
      priceEnv: "STRIPE_CREDITS_20000_PRICE_ID",
      displayPrice: "$160",
    },
  },
  creditCosts: {
    ai_generation: 10,
  },
} as const;

export type SubscriptionPlan = keyof typeof BILLING_CATALOG.subscriptionPlans;
export type CreditPack = keyof typeof BILLING_CATALOG.creditPacks;
export type Entitlement =
  (typeof BILLING_CATALOG.subscriptionPlans)[SubscriptionPlan]["entitlements"][number];
export type CreditAction = keyof typeof BILLING_CATALOG.creditCosts;
