import { and, desc, eq, exists, gte, inArray, isNull, sql } from "drizzle-orm";
import Stripe from "stripe";

import { getDb } from "#/db";
import { ApiError } from "#/lib/api-error";
import {
  billingAccount,
  creditBalance,
  creditTransaction,
  stripeEvent,
  subscription,
  user,
} from "#/db/schema";
import {
  BILLING_CATALOG,
  type CreditAction,
  type CreditPack,
  type Entitlement,
  type SubscriptionPlan,
} from "./config";
import { getPriceId, type BillingEnv } from "./config.server";

const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"] as const;

function getStripe(env: BillingEnv) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function getOrCreateBillingAccount(env: BillingEnv, userId: string) {
  const db = getDb(env.DB);
  const existing = await db.query.billingAccount.findFirst({
    where: eq(billingAccount.userId, userId),
  });

  if (!existing) {
    await db
      .insert(billingAccount)
      .values({ id: createId("billing"), userId })
      .onConflictDoNothing();
  }

  const account =
    existing ??
    (await db.query.billingAccount.findFirst({
      where: eq(billingAccount.userId, userId),
    }));

  if (!account) {
    throw new Error("Unable to create billing account");
  }

  await db.insert(creditBalance).values({ billingAccountId: account.id }).onConflictDoNothing();

  return account;
}

async function ensureStripeCustomer(env: BillingEnv, userId: string) {
  const db = getDb(env.DB);
  const account = await getOrCreateBillingAccount(env, userId);

  if (account.stripeCustomerId) {
    return { ...account, stripeCustomerId: account.stripeCustomerId };
  }

  const appUser = await db.query.user.findFirst({ where: eq(user.id, userId) });
  if (!appUser) {
    throw new Error("User not found");
  }

  const customer = await getStripe(env).customers.create({
    email: appUser.email,
    name: appUser.name,
    metadata: { billingAccountId: account.id, userId },
  });

  await db
    .update(billingAccount)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(and(eq(billingAccount.id, account.id), isNull(billingAccount.stripeCustomerId)));

  const updatedAccount = await db.query.billingAccount.findFirst({
    where: eq(billingAccount.id, account.id),
  });
  if (!updatedAccount?.stripeCustomerId) {
    throw new Error("Unable to attach Stripe customer");
  }

  return { ...updatedAccount, stripeCustomerId: updatedAccount.stripeCustomerId };
}

export async function getBillingSummary(env: BillingEnv, userId: string) {
  const db = getDb(env.DB);
  const account = await getOrCreateBillingAccount(env, userId);
  const balance = await db.query.creditBalance.findFirst({
    where: eq(creditBalance.billingAccountId, account.id),
  });
  const activeSubscriptions = await db.query.subscription.findMany({
    where: and(
      eq(subscription.billingAccountId, account.id),
      inArray(subscription.status, [...ACTIVE_SUBSCRIPTION_STATUSES]),
    ),
  });
  const recentTransactions = await db.query.creditTransaction.findMany({
    where: eq(creditTransaction.billingAccountId, account.id),
    orderBy: [desc(creditTransaction.createdAt)],
    limit: 10,
  });

  return {
    credits: balance?.balance ?? 0,
    plan: activeSubscriptions.some((item) => item.plan === "pro_monthly") ? "pro_monthly" : "free",
    subscriptions: activeSubscriptions,
    recentTransactions,
  };
}

export async function hasEntitlement(env: BillingEnv, userId: string, entitlement: Entitlement) {
  const summary = await getBillingSummary(env, userId);
  if (summary.plan !== "pro_monthly") return false;

  return BILLING_CATALOG.subscriptionPlans.pro_monthly.entitlements.includes(entitlement);
}

export async function grantCredits(
  env: BillingEnv,
  userId: string,
  amount: number,
  options: {
    type: "purchase" | "promotion" | "admin_grant";
    description?: string;
    reference: string;
  },
) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Credit grant must be a positive integer");
  }

  const db = getDb(env.DB);
  const account = await getOrCreateBillingAccount(env, userId);
  const entryId = createId("credit");
  const statements = await db.batch([
    db
      .insert(creditTransaction)
      .values({
        id: entryId,
        billingAccountId: account.id,
        amount,
        type: options.type,
        description: options.description,
        reference: options.reference,
      })
      .onConflictDoNothing(),
    db
      .update(creditBalance)
      .set({
        balance: sql`${creditBalance.balance} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(creditBalance.billingAccountId, account.id),
          exists(
            db
              .select({ id: creditTransaction.id })
              .from(creditTransaction)
              .where(eq(creditTransaction.id, entryId)),
          ),
        ),
      ),
  ]);

  return { granted: statements[0].meta.changes > 0 };
}

export async function consumeCredits(env: BillingEnv, userId: string, action: CreditAction) {
  const db = getDb(env.DB);
  const account = await getOrCreateBillingAccount(env, userId);
  const amount = BILLING_CATALOG.creditCosts[action];
  const entryId = createId("credit");
  const statements = await db.batch([
    db.insert(creditTransaction).select(
      db
        .select({
          id: sql<string>`${entryId}`.as("id"),
          billingAccountId: creditBalance.billingAccountId,
          amount: sql<number>`${-amount}`.as("amount"),
          type: sql<string>`${"usage"}`.as("type"),
          description: sql<string>`${action}`.as("description"),
          reference: sql<string>`${`usage:${entryId}`}`.as("reference"),
          createdAt: sql<Date>`(unixepoch())`.as("created_at"),
        })
        .from(creditBalance)
        .where(
          and(eq(creditBalance.billingAccountId, account.id), gte(creditBalance.balance, amount)),
        ),
    ),
    db
      .update(creditBalance)
      .set({
        balance: sql`${creditBalance.balance} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(creditBalance.billingAccountId, account.id),
          exists(
            db
              .select({ id: creditTransaction.id })
              .from(creditTransaction)
              .where(eq(creditTransaction.id, entryId)),
          ),
        ),
      ),
  ]);

  return { consumed: statements[0].meta.changes > 0, cost: amount };
}

export class InsufficientCreditsError extends ApiError {
  constructor(public readonly cost: number) {
    super(402, "Insufficient credits", { cost });
    this.name = "InsufficientCreditsError";
  }
}

export async function requireCredits(env: BillingEnv, userId: string, action: CreditAction) {
  const result = await consumeCredits(env, userId, action);
  if (!result.consumed) {
    throw new InsufficientCreditsError(result.cost);
  }
  return result;
}

export async function createSubscriptionCheckout(
  env: BillingEnv,
  userId: string,
  plan: SubscriptionPlan,
  origin: string,
) {
  const summary = await getBillingSummary(env, userId);
  if (summary.plan === plan) {
    throw new Error("Subscription is already active");
  }

  const account = await ensureStripeCustomer(env, userId);
  const item = BILLING_CATALOG.subscriptionPlans[plan];
  const session = await getStripe(env).checkout.sessions.create({
    customer: account.stripeCustomerId,
    mode: "subscription",
    line_items: [{ price: getPriceId(env, item.priceEnv), quantity: 1 }],
    success_url: `${origin}/billing?checkout=success`,
    cancel_url: `${origin}/billing?checkout=cancelled`,
    automatic_tax: { enabled: env.STRIPE_TAX_ENABLED === "true" },
    metadata: { billingAccountId: account.id, userId, purchaseType: "subscription", plan },
    subscription_data: { metadata: { billingAccountId: account.id, userId, plan } },
  });

  return session.url;
}

export async function createCreditsCheckout(
  env: BillingEnv,
  userId: string,
  pack: CreditPack,
  origin: string,
) {
  const account = await ensureStripeCustomer(env, userId);
  const item = BILLING_CATALOG.creditPacks[pack];
  const session = await getStripe(env).checkout.sessions.create({
    customer: account.stripeCustomerId,
    mode: "payment",
    line_items: [{ price: getPriceId(env, item.priceEnv), quantity: 1 }],
    success_url: `${origin}/billing?checkout=success`,
    cancel_url: `${origin}/billing?checkout=cancelled`,
    automatic_tax: { enabled: env.STRIPE_TAX_ENABLED === "true" },
    metadata: {
      billingAccountId: account.id,
      userId,
      purchaseType: "credits",
      creditPack: pack,
      credits: String(item.credits),
    },
  });

  return session.url;
}

export async function createCustomerPortal(env: BillingEnv, userId: string, origin: string) {
  const account = await ensureStripeCustomer(env, userId);
  const session = await getStripe(env).billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    return_url: `${origin}/billing`,
  });
  return session.url;
}

async function syncSubscription(env: BillingEnv, stripeSubscription: Stripe.Subscription) {
  const db = getDb(env.DB);
  const billingAccountId = stripeSubscription.metadata.billingAccountId;
  const plan = stripeSubscription.metadata.plan;
  if (!billingAccountId || !(plan in BILLING_CATALOG.subscriptionPlans)) {
    throw new Error("Subscription is missing billing metadata");
  }

  const item = stripeSubscription.items.data[0];
  await db
    .insert(subscription)
    .values({
      id: createId("subscription"),
      billingAccountId,
      stripeSubscriptionId: stripeSubscription.id,
      stripePriceId: item?.price.id,
      plan,
      status: stripeSubscription.status,
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
      currentPeriodEnd: item ? new Date(item.current_period_end * 1000) : null,
    })
    .onConflictDoUpdate({
      target: subscription.stripeSubscriptionId,
      set: {
        stripePriceId: item?.price.id,
        plan,
        status: stripeSubscription.status,
        cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
        currentPeriodEnd: item ? new Date(item.current_period_end * 1000) : null,
        updatedAt: new Date(),
      },
    });
}

async function processStripeEvent(env: BillingEnv, event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      if (session.mode !== "payment" || session.payment_status !== "paid") return;
      if (session.metadata?.purchaseType !== "credits") return;
      const userId = session.metadata?.userId;
      const credits = Number(session.metadata?.credits);
      if (!userId || !Number.isSafeInteger(credits)) {
        throw new Error("Credit checkout is missing billing metadata");
      }
      await grantCredits(env, userId, credits, {
        type: "purchase",
        description: session.metadata?.creditPack ?? "Credit purchase",
        reference: `stripe_checkout:${session.id}`,
      });
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(env, event.data.object);
  }
}

export async function handleStripeWebhook(env: BillingEnv, request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    throw new Error("Missing Stripe signature");
  }

  const payload = await request.text();
  const stripe = getStripe(env);
  const event = await stripe.webhooks.constructEventAsync(
    payload,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
  );
  const db = getDb(env.DB);
  await db.insert(stripeEvent).values({ id: event.id, type: event.type }).onConflictDoNothing();
  const storedEvent = await db.query.stripeEvent.findFirst({ where: eq(stripeEvent.id, event.id) });
  if (storedEvent?.processedAt) return;

  await processStripeEvent(env, event);
  await db.update(stripeEvent).set({ processedAt: new Date() }).where(eq(stripeEvent.id, event.id));
}
