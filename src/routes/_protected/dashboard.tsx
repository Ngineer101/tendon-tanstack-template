import { useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { Button } from "#/components/ui/button";
import { McpServerSection } from "#/components/mcp/McpServerSection";

export const Route = createFileRoute("/_protected/dashboard")({
  validateSearch: (search: Record<string, unknown>) => ({
    mcp_oauth:
      search.mcp_oauth === "success" || search.mcp_oauth === "error" ? search.mcp_oauth : undefined,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { mcp_oauth } = Route.useSearch();

  useEffect(() => {
    if (mcp_oauth) {
      window.history.replaceState(null, "", "/dashboard");
    }
  }, [mcp_oauth]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your authenticated SaaS starter dashboard.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/billing" search={{ checkout: undefined }}>
            <CreditCard className="size-4" />
            Open billing
          </Link>
        </Button>
      </div>

      {mcp_oauth === "success" && (
        <p className="mt-6 border border-primary/30 bg-primary/10 px-4 py-3 text-sm animate-in fade-in-0 slide-in-from-top-1">
          MCP server successfully connected via OAuth.
        </p>
      )}
      {mcp_oauth === "error" && (
        <p className="mt-6 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive animate-in fade-in-0 slide-in-from-top-1">
          OAuth connection failed. Please try again.
        </p>
      )}

      <div className="mt-10">
        <McpServerSection />
      </div>
    </div>
  );
}
