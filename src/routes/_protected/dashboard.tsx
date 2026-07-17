import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { McpServersPanel } from "#/components/mcp/McpServersPanel";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/_protected/dashboard")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { mcp?: "connected" | "error"; message?: string } => {
    const result: { mcp?: "connected" | "error"; message?: string } = {};
    if (search.mcp === "connected" || search.mcp === "error") result.mcp = search.mcp;
    if (typeof search.message === "string") result.message = search.message.slice(0, 200);
    return result;
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { mcp, message } = Route.useSearch();

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

      <McpServersPanel initialStatus={mcp} initialMessage={message} />
    </div>
  );
}
