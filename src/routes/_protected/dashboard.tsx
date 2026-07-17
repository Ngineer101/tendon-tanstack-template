import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { McpServersSection } from "#/components/mcp/mcp-servers-section";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/_protected/dashboard")({
  validateSearch: (search: Record<string, unknown>) => ({
    mcp:
      search.mcp === "connected" || search.mcp === "denied" || search.mcp === "error"
        ? search.mcp
        : undefined,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { mcp } = Route.useSearch();

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

      <McpServersSection banner={mcp} />
    </div>
  );
}
