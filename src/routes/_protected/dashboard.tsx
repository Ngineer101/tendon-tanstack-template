import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { McpServersSection } from "#/components/mcp/mcp-servers-section";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/_protected/dashboard")({
  validateSearch: (search: Record<string, unknown>) => {
    const result: { mcp?: "connected" | "error"; message?: string } = {};
    if (search.mcp === "connected" || search.mcp === "error") {
      result.mcp = search.mcp;
    }
    if (typeof search.message === "string") {
      result.message = search.message;
    }
    return result;
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { mcp, message } = Route.useSearch();

  return (
    <div className="mx-auto max-w-6xl p-4 py-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
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

      <McpServersSection callbackStatus={mcp} callbackMessage={message} />
    </div>
  );
}
