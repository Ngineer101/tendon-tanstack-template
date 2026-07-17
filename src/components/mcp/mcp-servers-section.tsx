import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Lock, Plus, RefreshCw, X } from "lucide-react";

import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { TooltipProvider } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";
import type { McpServerListResponse, PublicMcpServer } from "#/lib/mcp/config";
import { authorizeServer, disconnectServer, listServers, removeServer, testServer } from "./client";
import { McpServerCard } from "./mcp-server-card";
import { McpServerDialog } from "./mcp-server-dialog";

export interface McpCallbackParams {
  mcp?: "connected" | "error";
  mcpServer?: string;
  mcpMessage?: string;
}

interface Banner {
  kind: "success" | "error";
  text: string;
}

interface McpServersSectionProps {
  callback: McpCallbackParams;
  onCallbackHandled: () => void;
}

export function McpServersSection({ callback, onCallbackHandled }: McpServersSectionProps) {
  const [data, setData] = useState<McpServerListResponse>();
  const [loadError, setLoadError] = useState<string>();
  const [banner, setBanner] = useState<Banner>();
  const [highlightId, setHighlightId] = useState<string>();
  const [dialog, setDialog] = useState<{ open: boolean; editing?: PublicMcpServer }>({
    open: false,
  });
  const callbackHandled = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setData(await listServers());
      setLoadError(undefined);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "Unable to load MCP servers");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Absorb the OAuth callback result from the URL exactly once, then clean it
  // out of the address bar.
  useEffect(() => {
    if (!callback.mcp || callbackHandled.current) return;
    callbackHandled.current = true;
    if (callback.mcp === "connected") {
      setBanner({ kind: "success", text: "Server connected and ready to use." });
      setHighlightId(callback.mcpServer);
      setTimeout(() => setHighlightId(undefined), 3000);
    } else {
      setBanner({
        kind: "error",
        text: callback.mcpMessage ?? "Connecting the server failed.",
      });
    }
    onCallbackHandled();
  }, [callback, onCallbackHandled]);

  useEffect(() => {
    if (banner?.kind !== "success") return;
    const timer = setTimeout(() => setBanner(undefined), 6000);
    return () => clearTimeout(timer);
  }, [banner]);

  function patchServer(server: PublicMcpServer) {
    setData((current) =>
      current
        ? {
            ...current,
            servers: current.servers.map((item) => (item.id === server.id ? server : item)),
          }
        : current,
    );
  }

  async function handleConnect(server: PublicMcpServer) {
    const result = await authorizeServer(server.id);
    if (result.kind === "connected") {
      patchServer(result.server);
      setHighlightId(server.id);
      setTimeout(() => setHighlightId(undefined), 3000);
      return;
    }
    window.location.assign(result.authorizeUrl);
    // Keep the card in its pending state while the browser navigates away.
    await new Promise(() => {});
  }

  async function handleTest(server: PublicMcpServer) {
    const result = await testServer(server.id);
    patchServer(result.server);
    return result.healthy;
  }

  async function handleDisconnect(server: PublicMcpServer) {
    const result = await disconnectServer(server.id);
    patchServer(result.server);
  }

  async function handleRemove(server: PublicMcpServer) {
    await removeServer(server.id);
    await refresh();
  }

  const limit = data?.limit;
  const atLimit = !!limit && limit.max !== null && limit.used >= limit.max;

  return (
    <TooltipProvider>
      <section className="mt-12">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
              Integrations
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">MCP servers</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Connect Model Context Protocol servers to give your chat sessions access to your tools
              and data.
            </p>
          </div>
          {limit && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {limit.max === null ? (
                <span>
                  {limit.used} connected · <span className="text-primary">Unlimited on Pro</span>
                </span>
              ) : (
                <>
                  <span>
                    {limit.used} of {limit.max} servers
                  </span>
                  <span className="flex gap-0.5">
                    {Array.from({ length: limit.max }, (_, index) => (
                      <span
                        key={index}
                        className={cn(
                          "h-1.5 w-4 transition-colors duration-500",
                          index < limit.used ? "bg-primary" : "bg-border",
                        )}
                      />
                    ))}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {banner && (
          <div
            className={cn(
              "mt-6 flex items-center justify-between gap-3 border px-4 py-3 text-sm animate-in fade-in-0 slide-in-from-top-1 duration-300",
              banner.kind === "success"
                ? "border-emerald-500/30 bg-emerald-500/10"
                : "border-destructive/30 bg-destructive/10",
            )}
          >
            <span className="flex items-center gap-2">
              {banner.kind === "success" ? (
                <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
              ) : (
                <AlertTriangle className="size-4 shrink-0 text-destructive" />
              )}
              {banner.text}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              onClick={() => setBanner(undefined)}
            >
              <X />
            </Button>
          </div>
        )}

        {loadError ? (
          <div className="mt-6 flex items-center justify-between gap-3 border px-4 py-6 text-sm text-muted-foreground">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          </div>
        ) : !data ? (
          <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-44 rounded-none" />
            ))}
          </div>
        ) : (
          <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {data.servers.map((server, index) => (
              <McpServerCard
                key={server.id}
                server={server}
                index={index}
                highlighted={server.id === highlightId}
                onConnect={handleConnect}
                onTest={handleTest}
                onDisconnect={handleDisconnect}
                onRemove={handleRemove}
                onEdit={(editing) => setDialog({ open: true, editing })}
              />
            ))}

            {atLimit ? (
              <div className="flex min-h-44 flex-col items-center justify-center gap-3 border border-dashed p-6 text-center fill-mode-backwards animate-in fade-in-0 duration-300">
                <Lock className="size-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Free plan limit reached ({limit?.max} servers).
                </p>
                <Button asChild size="sm">
                  <Link to="/billing" search={{ checkout: undefined }}>
                    Upgrade for unlimited servers
                  </Link>
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setDialog({ open: true })}
                className="group flex min-h-44 flex-col items-center justify-center gap-3 border border-dashed p-6 text-center transition-colors duration-300 outline-none hover:border-primary/60 hover:bg-primary/5 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 fill-mode-backwards animate-in fade-in-0 duration-300"
                style={{ animationDelay: `${Math.min(data.servers.length, 8) * 60}ms` }}
              >
                <span className="flex size-9 items-center justify-center border border-dashed transition-all duration-300 group-hover:border-primary group-hover:bg-primary group-hover:text-primary-foreground">
                  <Plus className="size-4 transition-transform duration-300 group-hover:rotate-90" />
                </span>
                <span className="text-sm font-medium">
                  {data.servers.length === 0 ? "Connect your first MCP server" : "Add server"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {data.servers.length === 0
                    ? "Bring your own tools into chat — we handle discovery and OAuth."
                    : limit?.max === null
                      ? "Unlimited servers on your plan."
                      : `${limit ? limit.max - limit.used : 0} slot${limit && limit.max - limit.used === 1 ? "" : "s"} remaining on the free plan.`}
                </span>
              </button>
            )}
          </div>
        )}

        <McpServerDialog
          open={dialog.open}
          editing={dialog.editing}
          onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
          onSaved={refresh}
          onConnected={(serverId) => {
            setHighlightId(serverId);
            setTimeout(() => setHighlightId(undefined), 3000);
          }}
        />
      </section>
    </TooltipProvider>
  );
}
