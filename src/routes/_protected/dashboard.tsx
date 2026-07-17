import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard, TerminalSquare } from "lucide-react";

import { McpConnections } from "#/components/mcp/McpConnections";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/_protected/dashboard")({
  validateSearch: (search: Record<string, unknown>) => ({
    mcp:
      search.mcp === "connected"
        ? ("connected" as const)
        : search.mcp === "error"
          ? ("error" as const)
          : undefined,
    mcp_error: typeof search.mcp_error === "string" ? search.mcp_error : undefined,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-primary">
            <TerminalSquare className="size-4" />
            Automation console
          </div>
          <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
            Dashboard
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Configure the services your AI workspace can securely call on your behalf.
          </p>
        </div>
        <Button asChild variant="outline" className="self-start sm:self-auto">
          <Link to="/billing" search={{ checkout: undefined }}>
            <CreditCard className="size-4" />
            Plan & billing
          </Link>
        </Button>
      </header>

      <McpConnections oauthStatus={search.mcp} oauthError={search.mcp_error} />
    </div>
  );
}
