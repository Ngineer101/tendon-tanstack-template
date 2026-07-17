import { useCallback, useEffect, useState } from "react";
import { Plug, Plus, RefreshCw, ShieldAlert } from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import { parseJson, useTimedFlag } from "#/lib/mcp/client";
import type { McpListResult, McpServerPublic } from "#/lib/mcp/types";
import { ConnectMcpDialog, type ConnectOutcome } from "./ConnectMcpDialog";
import { McpServerCard } from "./McpServerCard";

interface McpServersPanelProps {
  /** Query-param status set by the OAuth callback redirect. */
  initialStatus?: "connected" | "error";
  initialMessage?: string;
}

export function McpServersPanel({ initialStatus, initialMessage }: McpServersPanelProps) {
  const [data, setData] = useState<McpListResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [actioningId, setActioningId] = useState<string>();
  const [toast, setToast] = useTimedFlag<{ kind: "ok" | "error"; text: string }>();

  const reload = useCallback(async () => {
    setError(undefined);
    setPending(true);
    try {
      const res = await fetch("/api/mcp/servers");
      const result = await parseJson<McpListResult>(res);
      setData(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load MCP servers");
    } finally {
      setPending(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Surface the OAuth-callback result as a toast. Also reload so the newly
  // connected / errored server appears instantly.
  useEffect(() => {
    if (!initialStatus) return;
    if (initialStatus === "connected") {
      setToast({ kind: "ok", text: "MCP server connected." });
    } else if (initialStatus === "error") {
      setToast({ kind: "error", text: initialMessage ?? "MCP authorization failed." });
    }
    void reload();
    // Intentionally only run this once on mount when the callback redirects
    // the user back to the dashboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAction<T>(
    id: string,
    fn: () => Promise<T>,
    okText: string,
    options: { reload?: boolean } = {},
  ): Promise<T | undefined> {
    setActioningId(id);
    try {
      const result = await fn();
      setToast({ kind: "ok", text: okText });
      if (options.reload !== false) await reload();
      return result;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Unable to complete the action";
      setToast({ kind: "error", text: message });
      return undefined;
    } finally {
      setActioningId(undefined);
    }
  }

  async function handleConnectedServer(outcome: ConnectOutcome) {
    void outcome;
    void reload();
  }

  const limit = data?.limit ?? null;
  const used = data?.used ?? 0;
  const reachedLimit = limit !== null && used >= limit;

  return (
    <section className="mt-12">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Integrations</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">MCP servers</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Connect Model Context Protocol servers to extend your chat sessions with external tools
            and resources. OAuth tokens are encrypted at rest and never exposed to the browser.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="border-primary/40 bg-primary/10 text-primary">
            <Plug className="size-3" />
            {limit === null ? "Unlimited" : `${used} / ${limit} used`}
          </Badge>
          <Button
            onClick={() => setConnectOpen(true)}
            disabled={reachedLimit}
            data-testid="mcp-connect"
          >
            <Plus className="size-4" />
            Connect server
          </Button>
        </div>
      </div>

      {toast && (
        <p
          role="status"
          className={
            "mt-4 animate-in fade-in-0 slide-in-from-bottom-2 duration-300 border px-4 py-3 text-sm " +
            (toast.kind === "ok"
              ? "border-primary/30 bg-primary/10"
              : "border-destructive/30 bg-destructive/10")
          }
        >
          {toast.kind === "ok" ? null : (
            <ShieldAlert className="mr-2 inline size-4 align-text-bottom" />
          )}
          {toast.text}
        </p>
      )}

      {error && (
        <p className="mt-4 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
          {error}
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pending && !data ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="animate-in fade-in-0 duration-500">
              <CardContent className="flex flex-col gap-2 p-4">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="mt-2 h-8 w-full" />
              </CardContent>
            </Card>
          ))
        ) : data && data.servers.length > 0 ? (
          data.servers.map((server, index) => (
            <div
              key={server.id}
              className="animate-in fade-in-0 slide-in-from-bottom-3 duration-500"
              style={{ animationDelay: `${index * 60}ms`, animationFillMode: "both" }}
            >
              <McpServerCard
                server={server}
                actioning={actioningId === server.id}
                onTest={(id) =>
                  runAction(id, () => handleTest(id), "Connection is healthy.", { reload: false })
                }
                onReconnect={async (id) => {
                  const result = await runAction(
                    id,
                    () => handleReconnect(id),
                    "Authorization started.",
                  );
                  if (result?.authorizationUrl) {
                    window.location.assign(result.authorizationUrl);
                  }
                }}
                onEdit={(id, patch) =>
                  runAction(id, () => handleEdit(id, patch), "Server updated.")
                }
                onDisconnect={(id) =>
                  runAction(id, () => handleDisconnect(id), "Server disconnected.")
                }
                onDelete={(id) => runAction(id, () => handleDelete(id), "Server deleted.")}
              />
            </div>
          ))
        ) : !pending ? (
          <EmptyState onConnect={() => setConnectOpen(true)} />
        ) : null}
      </div>

      <ConnectMcpDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={handleConnectedServer}
      />

      <button
        type="button"
        aria-label="Refresh MCP servers"
        onClick={() => void reload()}
        className="mt-6 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <RefreshCw className="size-3" />
        Refresh
      </button>
    </section>
  );
}

function EmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <Card className="border-dashed sm:col-span-2 lg:col-span-3">
      <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <Plug className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No MCP servers connected yet. Connect your first server to extend your chat sessions.
        </p>
        <Button variant="outline" size="sm" onClick={onConnect} className="mt-1">
          <Plus className="size-3" />
          Connect a server
        </Button>
      </CardContent>
    </Card>
  );
}

// --- Server action handlers (kept in the panel so the grid stays in sync) ---

async function handleTest(id: string) {
  const res = await fetch(`/api/mcp/servers/${id}`, { method: "POST" });
  return parseJson<{ status: string; message: string }>(res);
}

async function handleReconnect(
  id: string,
): Promise<{ serverId: string; authorizationUrl: string }> {
  const res = await fetch(`/api/mcp/servers/${id}`, { method: "PUT" });
  return parseJson<{ serverId: string; authorizationUrl: string }>(res);
}

async function handleEdit(id: string, patch: { name?: string; serverUrl?: string }) {
  const res = await fetch(`/api/mcp/servers/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return parseJson<McpServerPublic>(res);
}

async function handleDisconnect(id: string) {
  const res = await fetch(`/api/mcp/servers/${id}`, { method: "DELETE" });
  return parseJson<McpServerPublic>(res);
}

async function handleDelete(id: string) {
  const res = await fetch(`/api/mcp/servers/${id}?purge=true`, { method: "DELETE" });
  return parseJson<{ deleted: boolean }>(res);
}
