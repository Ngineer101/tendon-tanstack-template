import { useState, useEffect, useCallback } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CreditCard, Plus } from "lucide-react";

import { Button } from "#/components/ui/button";
import { McpConnectDialog } from "#/components/mcp/McpConnectDialog";
import { McpServerGrid } from "#/components/mcp/McpServerGrid";

interface ServerInfo {
  id: string;
  label: string;
  serverUrl: string;
  authStatus: string;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export const Route = createFileRoute("/_protected/dashboard")({
  component: RouteComponent,
});

function RouteComponent() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);

  const loadServers = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/mcp/servers");
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error ?? "Unable to load MCP servers");
      }
      setServers((await response.json()) as ServerInfo[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

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

      <section className="mt-12">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
              Integrations
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">MCP servers</h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Connect MCP servers to extend your chat sessions with custom tools and automations.
            </p>
          </div>
          <Button onClick={() => setConnectOpen(true)}>
            <Plus className="size-4" />
            Connect server
          </Button>
        </div>

        <div className="mt-4">
          <McpServerGrid
            servers={servers}
            loading={loading}
            error={error}
            onConnect={() => setConnectOpen(true)}
            onRefresh={() => void loadServers()}
          />
        </div>
      </section>

      <McpConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={() => void loadServers()}
      />
    </div>
  );
}
