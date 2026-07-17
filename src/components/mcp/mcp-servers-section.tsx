import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, Plus, Server, Sparkles, XCircle } from "lucide-react";

import { Button } from "#/components/ui/button";
import { Card } from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import { cn } from "#/lib/utils";
import { AddServerDialog } from "./add-server-dialog";
import { DisconnectServerDialog } from "./disconnect-server-dialog";
import { EditServerDialog } from "./edit-server-dialog";
import {
  apiRequest,
  type McpServerDto,
  type McpServerListResponse,
  type StartConnectionResponse,
  type TestServerResponse,
} from "./mcp-api";
import { ServerCard, type CardAction, type CardFeedback } from "./server-card";

interface McpServersSectionProps {
  /** Result of the OAuth redirect, surfaced by the dashboard route. */
  callbackStatus?: "connected" | "error";
  callbackMessage?: string;
}

export function McpServersSection({ callbackStatus, callbackMessage }: McpServersSectionProps) {
  const navigate = useNavigate();
  const [data, setData] = useState<McpServerListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<McpServerDto | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<McpServerDto | null>(null);

  const [pending, setPending] = useState<{ id: string; action: CardAction } | null>(null);
  const [feedback, setFeedback] = useState<Record<string, CardFeedback | null>>({});
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; message: string } | null>(null);
  const bannerTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const result = await apiRequest<McpServerListResponse>("/api/mcp/servers");
      setData(result);
      setLoadError(null);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "Unable to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Surface the OAuth callback result once, then scrub the URL params.
  useEffect(() => {
    if (!callbackStatus) return;
    showBanner(
      callbackStatus === "connected",
      callbackStatus === "connected"
        ? "MCP server connected and credentials stored securely."
        : (callbackMessage ?? "Could not connect the MCP server."),
    );
    void navigate({
      to: "/dashboard",
      search: {},
      replace: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callbackStatus]);

  function showBanner(ok: boolean, message: string) {
    window.clearTimeout(bannerTimer.current);
    setBanner({ ok, message });
    bannerTimer.current = window.setTimeout(() => setBanner(null), ok ? 5000 : 9000);
  }

  function setCardFeedback(serverId: string, value: CardFeedback | null) {
    setFeedback((current) => ({ ...current, [serverId]: value }));
  }

  async function handleTest(server: McpServerDto) {
    setPending({ id: server.id, action: "test" });
    setCardFeedback(server.id, null);
    try {
      const result = await apiRequest<TestServerResponse>(`/api/mcp/servers/${server.id}/test`, {
        method: "POST",
      });
      setCardFeedback(server.id, {
        ok: true,
        message: `Connection healthy — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`,
      });
    } catch (reason) {
      setCardFeedback(server.id, {
        ok: false,
        message: reason instanceof Error ? reason.message : "Connection test failed",
      });
    } finally {
      setPending(null);
      void load();
    }
  }

  async function handleReconnect(server: McpServerDto) {
    setPending({ id: server.id, action: "reconnect" });
    setCardFeedback(server.id, null);
    try {
      const result = await apiRequest<StartConnectionResponse>(
        `/api/mcp/servers/${server.id}/reconnect`,
        { method: "POST" },
      );
      if (result.type === "authorization_required") {
        window.location.assign(result.authorizationUrl);
        return;
      }
      setCardFeedback(server.id, { ok: true, message: "Server reconnected." });
      await load();
    } catch (reason) {
      setCardFeedback(server.id, {
        ok: false,
        message: reason instanceof Error ? reason.message : "Could not reconnect the server",
      });
    } finally {
      setPending(null);
    }
  }

  function handleAction(action: CardAction, server: McpServerDto) {
    if (action === "test") void handleTest(server);
    else if (action === "reconnect") void handleReconnect(server);
    else if (action === "edit") setEditTarget(server);
    else if (action === "disconnect") setDisconnectTarget(server);
  }

  function handleDisconnected(serverId: string) {
    setDisconnectTarget(null);
    setRemovingId(serverId);
    // Let the exit animation play before removing the card from the grid.
    window.setTimeout(() => {
      setData((current) =>
        current
          ? {
              ...current,
              servers: current.servers.filter((server) => server.id !== serverId),
              quota: { ...current.quota, used: Math.max(0, current.quota.used - 1) },
            }
          : current,
      );
      setRemovingId(null);
    }, 250);
  }

  const quota = data?.quota;
  const servers = data?.servers ?? [];
  const atLimit = !!quota && quota.limit !== null && quota.used >= quota.limit;
  const limit = quota?.limit ?? null;

  return (
    <section className="mt-12" aria-labelledby="mcp-servers-heading">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">MCP servers</p>
          <h2 id="mcp-servers-heading" className="mt-2 text-2xl font-semibold tracking-tight">
            Connected tools
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Connect MCP servers to give your chat sessions access to external tools. Credentials are
            encrypted at rest.
          </p>
        </div>
        {quota && (
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-xs text-muted-foreground">
                {limit === null ? (
                  <>
                    <span className="font-medium text-foreground">{quota.used}</span> connected ·
                    Pro
                  </>
                ) : (
                  <>
                    <span className="font-medium text-foreground">{quota.used}</span> of{" "}
                    <span className="font-medium text-foreground">{limit}</span> used · Free
                  </>
                )}
              </p>
              {limit !== null && (
                <div className="mt-1.5 h-1 w-28 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-700 ease-out",
                      atLimit ? "bg-amber-500" : "bg-primary",
                    )}
                    style={{ width: `${Math.min(100, (quota.used / limit) * 100)}%` }}
                  />
                </div>
              )}
            </div>
            <Button onClick={() => setAddOpen(true)} disabled={atLimit} size="sm">
              <Plus className="size-4" />
              Add server
            </Button>
          </div>
        )}
      </div>

      {banner && (
        <p
          className={cn(
            "mt-6 flex items-center gap-2 border px-4 py-3 text-sm animate-in fade-in-0 slide-in-from-top-2 duration-300",
            banner.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
          role="status"
        >
          {banner.ok ? (
            <CheckCircle2 className="size-4 shrink-0" />
          ) : (
            <XCircle className="size-4 shrink-0" />
          )}
          {banner.message}
        </p>
      )}

      {atLimit && (
        <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 animate-in fade-in-0 duration-300 dark:text-amber-400">
          <Sparkles className="size-4 shrink-0" />
          You've reached the free plan limit of {limit} servers.
          <Link
            to="/billing"
            search={{ checkout: undefined }}
            className="font-medium underline underline-offset-4 hover:text-foreground"
          >
            Upgrade to Pro for unlimited servers
          </Link>
        </p>
      )}

      {loadError && (
        <div className="mt-6 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
          <p>{loadError}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            Retry
          </Button>
        </div>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {loading &&
          [0, 1, 2].map((index) => (
            <Card key={index} className="p-5">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-9" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
              <Skeleton className="mt-4 h-3 w-1/3" />
              <Skeleton className="mt-4 h-7 w-full" />
            </Card>
          ))}

        {!loading &&
          servers.map((server, index) => (
            <div
              key={server.id}
              className={cn(
                removingId === server.id &&
                  "pointer-events-none animate-out fade-out-0 zoom-out-95 duration-200",
              )}
            >
              <ServerCard
                server={server}
                pendingAction={pending?.id === server.id ? pending.action : null}
                feedback={feedback[server.id] ?? null}
                style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
                onAction={handleAction}
              />
            </div>
          ))}

        {!loading && !atLimit && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="group flex min-h-44 flex-col items-center justify-center gap-2.5 border border-dashed bg-transparent p-6 text-muted-foreground transition-all duration-300 animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both hover:border-primary/50 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            style={{ animationDelay: `${Math.min(servers.length, 8) * 60}ms` }}
          >
            <span className="flex size-10 items-center justify-center rounded-full border bg-background transition-transform duration-300 group-hover:scale-110 group-hover:border-primary/50">
              <Plus className="size-4 transition-transform duration-300 group-hover:rotate-90" />
            </span>
            <span className="text-sm font-medium">
              {servers.length === 0 ? "Connect your first MCP server" : "Add another server"}
            </span>
            <span className="text-xs">OAuth discovery & encrypted storage</span>
          </button>
        )}

        {!loading && servers.length === 0 && atLimit && null}
      </div>

      {!loading && servers.length === 0 && (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground animate-in fade-in-0 duration-500">
          <Server className="size-3.5" />
          MCP servers you connect appear here and become available to your chat sessions.
        </p>
      )}

      <AddServerDialog open={addOpen} onOpenChange={setAddOpen} onConnected={() => void load()} />

      <EditServerDialog
        server={editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        onSaved={(server, urlChanged) => {
          setEditTarget(null);
          setData((current) =>
            current
              ? {
                  ...current,
                  servers: current.servers.map((item) => (item.id === server.id ? server : item)),
                }
              : current,
          );
          if (urlChanged) {
            showBanner(false, "Server URL updated — reconnect to authorize the new endpoint.");
          }
        }}
      />

      <DisconnectServerDialog
        server={disconnectTarget}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(null);
        }}
        onDisconnected={handleDisconnected}
      />
    </section>
  );
}
