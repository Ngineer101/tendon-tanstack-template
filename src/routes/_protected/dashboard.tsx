import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { McpServers } from "#/components/mcp/McpServers";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/_protected/dashboard")({
  component: RouteComponent,
});

function RouteComponent() {
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

      <McpServers />
    </div>
  );
}
