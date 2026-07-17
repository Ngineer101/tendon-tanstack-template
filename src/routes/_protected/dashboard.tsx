import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { Button } from "#/components/ui/button";
import { McpServersSection, type McpCallbackResult } from "#/components/mcp/mcp-servers-section";

interface DashboardSearch {
  mcp?: "connected";
  mcp_error?: string;
  mcp_server?: string;
}

export const Route = createFileRoute("/_protected/dashboard")({
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    mcp: search.mcp === "connected" ? "connected" : undefined,
    mcp_error: typeof search.mcp_error === "string" ? search.mcp_error : undefined,
    mcp_server: typeof search.mcp_server === "string" ? search.mcp_server : undefined,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  const callback: McpCallbackResult | undefined =
    search.mcp === "connected"
      ? { status: "connected", serverId: search.mcp_server }
      : search.mcp_error
        ? { status: "error", errorCode: search.mcp_error }
        : undefined;

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

      <McpServersSection
        callback={callback}
        onDismissCallback={() =>
          void navigate({
            to: "/dashboard",
            search: { mcp: undefined, mcp_error: undefined, mcp_server: undefined },
            replace: true,
          })
        }
      />
    </div>
  );
}
