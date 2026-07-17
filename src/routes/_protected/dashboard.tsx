import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { McpServersSection } from "#/components/mcp/mcp-servers-section";
import { Button } from "#/components/ui/button";

export const Route = createFileRoute("/_protected/dashboard")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { mcp?: "connected" | "error"; mcpName?: string; mcpDetail?: string } => ({
    mcp: search.mcp === "connected" || search.mcp === "error" ? search.mcp : undefined,
    mcpName: typeof search.mcpName === "string" ? search.mcpName : undefined,
    mcpDetail: typeof search.mcpDetail === "string" ? search.mcpDetail : undefined,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { mcp, mcpName, mcpDetail } = Route.useSearch();
  const navigate = useNavigate();

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
        callbackResult={mcp ? { kind: mcp, name: mcpName, detail: mcpDetail } : undefined}
        onDismissCallbackResult={() =>
          void navigate({
            to: "/dashboard",
            search: { mcp: undefined, mcpName: undefined, mcpDetail: undefined },
            replace: true,
          })
        }
      />
    </div>
  );
}
