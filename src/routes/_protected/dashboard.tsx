import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { McpServersSection } from "#/components/mcp/mcp-servers-section";
import { Button } from "#/components/ui/button";
import { MCP_OAUTH_RESULTS, type McpOauthResult } from "#/lib/mcp/config";

interface DashboardSearch {
  mcp?: McpOauthResult;
  reason?: string;
}

export const Route = createFileRoute("/_protected/dashboard")({
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    mcp: MCP_OAUTH_RESULTS.includes(search.mcp as McpOauthResult)
      ? (search.mcp as McpOauthResult)
      : undefined,
    reason: typeof search.reason === "string" ? search.reason : undefined,
  }),
  component: RouteComponent,
});

const OAUTH_RESULT_MESSAGES: Record<McpOauthResult, string> = {
  connected: "MCP server authorized and connected successfully.",
  cancelled:
    "Authorization was cancelled. The server is saved — finish setup whenever you're ready.",
  error: "Authorization could not be completed. Please try reconnecting the server.",
};

function RouteComponent() {
  const { mcp } = Route.useSearch();
  const [plan, setPlan] = useState<"free" | "pro_monthly">();

  useEffect(() => {
    fetch("/api/billing/summary")
      .then(async (response) => {
        if (!response.ok) return;
        const summary = (await response.json()) as { plan?: "free" | "pro_monthly" };
        setPlan(summary.plan === "pro_monthly" ? "pro_monthly" : "free");
      })
      .catch(() => undefined);
  }, []);

  return (
    <div className="mx-auto max-w-6xl p-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your authenticated SaaS starter dashboard.
      </p>
      <Button asChild variant="outline" className="mt-6">
        <Link to="/billing" search={{ checkout: undefined }}>
          <CreditCard className="size-4" />
          Open billing
        </Link>
      </Button>

      {mcp && (
        <p
          className={
            mcp === "error"
              ? "mt-6 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm animate-in fade-in-0 slide-in-from-top-1 duration-200"
              : "mt-6 border border-primary/30 bg-primary/10 px-4 py-3 text-sm animate-in fade-in-0 slide-in-from-top-1 duration-200"
          }
        >
          {OAUTH_RESULT_MESSAGES[mcp]}
        </p>
      )}

      <McpServersSection plan={plan} />
    </div>
  );
}
