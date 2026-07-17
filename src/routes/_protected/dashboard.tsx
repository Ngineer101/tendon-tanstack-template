import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard, LayoutDashboard } from "lucide-react";

import { Button } from "#/components/ui/button";
import { McpServersPanel } from "#/components/mcp/McpServersPanel";

type DashboardSearch = {
  mcp?: "connected" | "error" | "resume";
  message?: string;
};

export const Route = createFileRoute("/_protected/dashboard")({
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    mcp:
      search.mcp === "connected" || search.mcp === "error" || search.mcp === "resume"
        ? search.mcp
        : undefined,
    message: typeof search.message === "string" ? search.message : undefined,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { mcp, message } = Route.useSearch();

  return (
    <div className="mx-auto max-w-6xl p-4 py-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
            Control center
          </p>
          <h1 className="mt-2 flex items-center gap-3 text-3xl font-semibold tracking-tight">
            <LayoutDashboard className="size-7 text-primary" />
            Dashboard
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Manage account capabilities and connect MCP servers for automated chat workflows.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/billing" search={{ checkout: undefined }}>
            <CreditCard className="size-4" />
            Open billing
          </Link>
        </Button>
      </div>

      <McpServersPanel oauthMessage={mcp ? { type: mcp, message } : undefined} />
    </div>
  );
}
