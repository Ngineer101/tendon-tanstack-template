import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { Button } from "#/components/ui/button";
import { MCPGrid } from "#/components/mcp/MCPGrid";

export const Route = createFileRoute("/_protected/dashboard")({
  component: RouteComponent,
});

function Toast({
  message,
  variant,
  onDone,
}: {
  message: string;
  variant: "success" | "error";
  onDone: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div
      className={`animate-in fade-in-0 slide-in-from-top-2 fixed top-16 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2.5 text-sm shadow-lg ${
        variant === "success"
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-destructive/30 bg-destructive/10 text-destructive"
      }`}
    >
      {message}
    </div>
  );
}

function RouteComponent() {
  const [toast, setToast] = useState<{ message: string; variant: "success" | "error" }>();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mcpConnected = params.get("mcp_connected");
    const mcpError = params.get("mcp_error");

    if (mcpConnected === "1") {
      setToast({ message: "MCP server connected successfully", variant: "success" });
    } else if (mcpError) {
      setToast({ message: mcpError, variant: "error" });
    }

    if (mcpConnected || mcpError) {
      const url = new URL(window.location.href);
      url.searchParams.delete("mcp_connected");
      url.searchParams.delete("mcp_error");
      window.history.replaceState({}, "", url);
    }
  }, []);

  return (
    <div className="mx-auto max-w-6xl p-4 py-10">
      {toast && (
        <Toast message={toast.message} variant={toast.variant} onDone={() => setToast(undefined)} />
      )}

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
            Your workspace
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Your authenticated SaaS starter dashboard. Manage your MCP servers and billing from
            here.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/billing" search={{ checkout: undefined }}>
            <CreditCard className="size-4" />
            Open billing
          </Link>
        </Button>
      </div>

      <div className="mt-10">
        <MCPGrid onToast={(message, variant) => setToast({ message, variant })} />
      </div>
    </div>
  );
}
