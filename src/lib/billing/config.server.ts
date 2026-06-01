export interface BillingEnv extends Cloudflare.Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRO_MONTHLY_PRICE_ID: string;
  STRIPE_CREDITS_1000_PRICE_ID: string;
  STRIPE_CREDITS_5000_PRICE_ID: string;
  STRIPE_CREDITS_20000_PRICE_ID: string;
  STRIPE_TAX_ENABLED?: string;
}

type PriceEnv = keyof Pick<
  BillingEnv,
  | "STRIPE_PRO_MONTHLY_PRICE_ID"
  | "STRIPE_CREDITS_1000_PRICE_ID"
  | "STRIPE_CREDITS_5000_PRICE_ID"
  | "STRIPE_CREDITS_20000_PRICE_ID"
>;

export function getPriceId(env: BillingEnv, priceEnv: PriceEnv) {
  const priceId = env[priceEnv];

  if (!priceId) {
    throw new Error(`Missing billing configuration: ${priceEnv}`);
  }

  return priceId;
}
