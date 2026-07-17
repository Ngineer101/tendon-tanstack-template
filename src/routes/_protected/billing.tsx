import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Coins, CreditCard, LayoutDashboard, Sparkles } from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { BILLING_CATALOG } from "#/lib/billing/config";

interface BillingSummary {
  credits: number;
  plan: "free" | "pro_monthly";
  recentTransactions: Array<{
    id: string;
    amount: number;
    type: string;
    description: string | null;
    createdAt: string;
  }>;
}

export const Route = createFileRoute("/_protected/billing")({
  validateSearch: (search: Record<string, unknown>) => ({
    checkout:
      search.checkout === "success" || search.checkout === "cancelled"
        ? search.checkout
        : undefined,
  }),
  component: Billing,
});

function Billing() {
  const { checkout } = Route.useSearch();
  const [summary, setSummary] = useState<BillingSummary>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();

  async function loadSummary() {
    const response = await fetch("/api/billing/summary");
    if (!response.ok) throw new Error("Unable to load billing details");
    setSummary((await response.json()) as BillingSummary);
  }

  useEffect(() => {
    void loadSummary().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Unable to load billing details");
    });
  }, []);

  async function openBillingUrl(path: string, body?: object) {
    setError(undefined);
    setPending(path + JSON.stringify(body));
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const result = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !result.url) throw new Error(result.error ?? "Unable to open Stripe");
      window.location.assign(result.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to open Stripe");
      setPending(undefined);
    }
  }

  async function consumeDemoCredits() {
    setError(undefined);
    setPending("consume");
    try {
      const response = await fetch("/api/billing/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "ai_generation" }),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 402
            ? "You need more credits for another AI generation."
            : "Unable to consume credits",
        );
      }
      await loadSummary();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to consume credits");
    } finally {
      setPending(undefined);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <Link
        to="/dashboard"
        search={{ mcp: undefined }}
        className="mb-8 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to dashboard
      </Link>

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
            Account billing
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Plan and usage</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Subscribe for premium features and top up credits for usage-based actions.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void openBillingUrl("/api/billing/portal")}
          disabled={!!pending}
        >
          <CreditCard className="size-4" />
          Manage in Stripe
        </Button>
      </div>

      {checkout === "success" && (
        <p className="mt-6 border border-primary/30 bg-primary/10 px-4 py-3 text-sm">
          Payment complete. Stripe is syncing your billing details.
        </p>
      )}
      {checkout === "cancelled" && (
        <p className="mt-6 border px-4 py-3 text-sm">Checkout was cancelled.</p>
      )}
      {error && (
        <p className="mt-6 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
          {error}
        </p>
      )}

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Current plan</CardDescription>
            <CardTitle className="text-2xl">
              {summary?.plan === "pro_monthly" ? "Pro" : "Free"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge>
              {summary?.plan === "pro_monthly" ? "Premium dashboard unlocked" : "Basic access"}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Available credits</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <Coins className="size-5 text-primary" />
              {summary?.credits.toLocaleString() ?? "Loading..."}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">Credits never expire.</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Usage demo</CardDescription>
            <CardTitle className="text-base">AI generation</CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={() => void consumeDemoCredits()}
              disabled={!!pending}
            >
              <Sparkles className="size-4" />
              Use {BILLING_CATALOG.creditCosts.ai_generation} credits
            </Button>
          </CardContent>
        </Card>
      </div>

      <section className="mt-12">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Subscription</p>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Free</CardTitle>
              <CardDescription>Start with the essentials.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">$0</p>
            </CardContent>
          </Card>
          <Card className="border-primary/60">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                Pro
                <Badge className="border-primary/40 bg-primary/10 text-primary">Recommended</Badge>
              </CardTitle>
              <CardDescription>
                {BILLING_CATALOG.subscriptionPlans.pro_monthly.description}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">
                {BILLING_CATALOG.subscriptionPlans.pro_monthly.displayPrice}
                <span className="text-sm font-normal text-muted-foreground"> / month</span>
              </p>
              <Button
                className="mt-5"
                onClick={() =>
                  void openBillingUrl("/api/billing/checkout", {
                    type: "subscription",
                    item: "pro_monthly",
                  })
                }
                disabled={!!pending || summary?.plan === "pro_monthly"}
              >
                <LayoutDashboard className="size-4" />
                {summary?.plan === "pro_monthly" ? "Current plan" : "Upgrade to Pro"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="mt-12">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Prepaid credits</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">Top up whenever you need</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {Object.entries(BILLING_CATALOG.creditPacks).map(([id, pack]) => (
            <Card key={id}>
              <CardHeader>
                <CardTitle>{pack.name}</CardTitle>
                <CardDescription>{pack.credits.toLocaleString()} credits</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{pack.displayPrice}</p>
                <Button
                  variant="outline"
                  className="mt-5"
                  onClick={() =>
                    void openBillingUrl("/api/billing/checkout", { type: "credits", item: id })
                  }
                  disabled={!!pending}
                >
                  <Coins className="size-4" />
                  Buy credits
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-12">
        <h2 className="text-xl font-semibold tracking-tight">Recent credit activity</h2>
        <div className="mt-4 border">
          {!summary?.recentTransactions.length ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No credit activity yet.
            </p>
          ) : (
            summary.recentTransactions.map((transaction) => (
              <div
                key={transaction.id}
                className="flex items-center justify-between border-b px-4 py-3 last:border-b-0"
              >
                <div>
                  <p className="text-sm font-medium">
                    {transaction.description ?? transaction.type}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(transaction.createdAt).toLocaleString()}
                  </p>
                </div>
                <span className={transaction.amount > 0 ? "text-sm text-primary" : "text-sm"}>
                  {transaction.amount > 0 ? "+" : ""}
                  {transaction.amount.toLocaleString()}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
