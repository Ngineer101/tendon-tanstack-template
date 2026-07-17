import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { Button } from "#/components/ui/button";
import { McpServersSection } from "#/components/mcp/mcp-servers-section";

export const Route = createFileRoute("/_protected/dashboard")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { mcp?: "connected" | "error"; mcpServer?: string; mcpMessage?: string } => ({
    mcp: search.mcp === "connected" || search.mcp === "error" ? search.mcp : undefined,
    mcpServer: typeof search.mcpServer === "string" ? search.mcpServer : undefined,
    mcpMessage: typeof search.mcpMessage === "string" ? search.mcpMessage : undefined,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  return (
    <div className="mx-auto max-w-6xl p-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
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

      <McpServersSection
        callback={search}
        onCallbackHandled={() =>
          void navigate({
            to: "/dashboard",
            search: { mcp: undefined, mcpServer: undefined, mcpMessage: undefined },
            replace: true,
          })
        }
      />
    </div>
  );
}
