import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Plug, Plus, XCircle, X } from "lucide-react";

import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { TooltipProvider } from "#/components/ui/tooltip";
import { MCP_FREE_SERVER_LIMIT } from "#/lib/mcp/config";
import { cn } from "#/lib/utils";
import { MCP_SERVERS_QUERY_KEY, mcpApi } from "./api";
import { ConnectServerDialog } from "./connect-server-dialog";
import { McpServerCard } from "./mcp-server-card";

interface McpServersSectionProps {
  callbackResult?: { kind: "connected" | "error"; name?: string; detail?: string };
  onDismissCallbackResult: () => void;
}

export function McpServersSection({
  callbackResult,
  onDismissCallbackResult,
}: McpServersSectionProps) {
  const [connectOpen, setConnectOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const { data, isPending, isError } = useQuery({
    queryKey: MCP_SERVERS_QUERY_KEY,
    queryFn: mcpApi.list,
  });

  const usage = data?.usage;
  const servers = data?.servers ?? [];
  const atLimit =
    !!usage && !usage.unlimited && usage.used >= (usage.limit ?? MCP_FREE_SERVER_LIMIT);

  return (
    <section className="mt-12">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Integrations</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">MCP servers</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Connect Model Context Protocol servers to give your chat sessions extra tools.
          </p>
        </div>
        <div className="flex items-center gap-4">
          {usage && (
            <div className="text-right">
              <p className="font-mono text-xs text-muted-foreground">
                {usage.unlimited ? (
                  <span className="text-primary">Unlimited servers</span>
                ) : (
                  <>
                    <span className={cn(atLimit && "text-primary")}>{usage.used}</span> /{" "}
                    {usage.limit} connected
                  </>
                )}
              </p>
              {!usage.unlimited && (
                <div className="mt-1.5 h-1 w-28 overflow-hidden bg-muted">
                  <div
                    className={cn(
                      "h-full transition-all duration-500 ease-out",
                      atLimit ? "bg-primary" : "bg-primary/60",
                    )}
                    style={{
                      width: `${Math.min(100, (usage.used / (usage.limit ?? 1)) * 100)}%`,
                    }}
                  />
                </div>
              )}
            </div>
          )}
          <Button onClick={() => setConnectOpen(true)} data-testid="connect-server-button">
            <Plus className="size-4" />
            Connect server
          </Button>
        </div>
      </div>

      {callbackResult && (
        <div
          className={cn(
            "mt-6 flex animate-in items-center gap-3 border px-4 py-3 text-sm fade-in-0 slide-in-from-top-2 duration-300",
            callbackResult.kind === "connected"
              ? "border-emerald-500/30 bg-emerald-500/10"
              : "border-destructive/30 bg-destructive/10",
          )}
          role="status"
        >
          {callbackResult.kind === "connected" ? (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
          ) : (
            <XCircle className="size-4 shrink-0 text-destructive" />
          )}
          <span className="flex-1">
            {callbackResult.kind === "connected" ? (
              <>
                <span className="font-medium">{callbackResult.name ?? "Server"}</span> was
                authorized and is now connected.
              </>
            ) : (
              <>
                Authorization failed
                {callbackResult.name ? (
                  <>
                    {" "}
                    for <span className="font-medium">{callbackResult.name}</span>
                  </>
                ) : null}
                {callbackResult.detail ? `: ${callbackResult.detail}` : "."}
              </>
            )}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onDismissCallbackResult}
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      {actionError && (
        <div
          className="mt-6 flex animate-in items-center gap-3 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm fade-in-0 slide-in-from-top-2 duration-300"
          role="alert"
        >
          <XCircle className="size-4 shrink-0 text-destructive" />
          <span className="flex-1">{actionError}</span>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setActionError(undefined)}
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      <div className="mt-6">
        {isPending ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-44" />
            ))}
          </div>
        ) : isError ? (
          <p className="border border-destructive/30 bg-destructive/10 px-4 py-8 text-center text-sm">
            Unable to load your MCP servers. Refresh the page to try again.
          </p>
        ) : servers.length === 0 ? (
          <button
            type="button"
            onClick={() => setConnectOpen(true)}
            className="group flex w-full animate-in flex-col items-center gap-3 border border-dashed px-4 py-14 text-center fade-in-0 duration-500 transition-colors hover:border-primary/50 hover:bg-primary/5"
          >
            <span className="flex size-12 items-center justify-center border bg-muted transition-all duration-300 group-hover:scale-105 group-hover:border-primary/40 group-hover:bg-primary/10">
              <Plug className="size-5 text-muted-foreground transition-colors group-hover:text-primary" />
            </span>
            <span className="text-sm font-medium">No MCP servers connected yet</span>
            <span className="max-w-sm text-xs text-muted-foreground">
              Connect your first server to bring external tools — code hosts, databases, internal
              APIs — into your chat sessions.
            </span>
          </button>
        ) : (
          <TooltipProvider>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {servers.map((server, index) => (
                <McpServerCard
                  key={server.id}
                  server={server}
                  index={index}
                  onError={setActionError}
                />
              ))}
            </div>
          </TooltipProvider>
        )}
      </div>

      <ConnectServerDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        atLimit={atLimit}
        limit={usage?.limit ?? MCP_FREE_SERVER_LIMIT}
      />
    </section>
  );
}
