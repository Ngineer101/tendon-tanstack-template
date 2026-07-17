import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Plus, Server, Sparkles, X } from "lucide-react";

import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { TooltipProvider } from "#/components/ui/tooltip";
import { FREE_MCP_SERVER_LIMIT, type McpServerView } from "#/lib/mcp/config";
import { cn } from "#/lib/utils";
import { McpApiError, mcpApi } from "./api";
import { ServerCard } from "./server-card";
import { ServerFormDialog } from "./server-form-dialog";

export interface McpCallbackResult {
  status: "connected" | "error";
  errorCode?: string;
  serverId?: string;
}

const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Authorization was declined on the server. Nothing was connected.",
  state_invalid: "The authorization link expired or was already used. Try reconnecting.",
  oauth_failed: "The authorization server returned an error. Try reconnecting.",
  callback_failed: "Finishing the authorization failed. Test the server or reconnect.",
};

export function McpServersSection({
  callback,
  onDismissCallback,
}: {
  callback?: McpCallbackResult;
  onDismissCallback: () => void;
}) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerView>();
  const [actionError, setActionError] = useState<string>();
  const [busyServer, setBusyServer] = useState<{
    id: string;
    action: "testing" | "authorizing" | "deleting";
  }>();
  const [lastTests, setLastTests] = useState<Record<string, { ok: boolean; latencyMs?: number }>>(
    {},
  );

  const query = useQuery({ queryKey: ["mcp-servers"], queryFn: mcpApi.list });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });

  const testMutation = useMutation({
    mutationFn: mcpApi.test,
    onMutate: (serverId: string) => setBusyServer({ id: serverId, action: "testing" }),
    onSuccess: (result, serverId) => {
      setLastTests((current) => ({
        ...current,
        [serverId]: { ok: result.ok, latencyMs: result.latencyMs },
      }));
      void invalidate();
    },
    onError: (reason) => {
      setActionError(reason instanceof Error ? reason.message : "Connection test failed");
    },
    onSettled: () => setBusyServer(undefined),
  });

  const deleteMutation = useMutation({
    mutationFn: mcpApi.remove,
    onMutate: (serverId: string) => setBusyServer({ id: serverId, action: "deleting" }),
    onSuccess: () => void invalidate(),
    onError: (reason) => {
      setActionError(reason instanceof Error ? reason.message : "Unable to disconnect the server");
    },
    onSettled: () => setBusyServer(undefined),
  });

  async function reconnect(server: McpServerView) {
    setActionError(undefined);
    setBusyServer({ id: server.id, action: "authorizing" });
    try {
      const { authorizationUrl } = await mcpApi.authorize(server.id);
      window.location.assign(authorizationUrl);
    } catch (reason) {
      setBusyServer(undefined);
      if (reason instanceof McpApiError && reason.status === 400) {
        // The server stopped requiring auth; a plain test will reconnect it.
        testMutation.mutate(server.id);
        return;
      }
      setActionError(reason instanceof Error ? reason.message : "Unable to start authorization");
    }
  }

  const data = query.data;
  const servers = data?.servers ?? [];
  const limit = data?.limit;
  const atLimit = limit ? !limit.canAdd : false;

  return (
    <TooltipProvider>
      <section className="mt-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
              Integrations
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">MCP servers</h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Connect Model Context Protocol servers to bring their tools into your chat sessions.
            </p>
          </div>
          {limit && (
            <div className="flex flex-col items-end gap-1.5">
              <p className="text-xs text-muted-foreground">
                {limit.max === null ? (
                  <span className="inline-flex items-center gap-1">
                    <Sparkles className="size-3 text-primary" />
                    Unlimited servers on Pro
                  </span>
                ) : (
                  `${limit.used} of ${limit.max} servers connected`
                )}
              </p>
              {limit.max !== null && (
                <div className="flex gap-1">
                  {Array.from({ length: limit.max }, (_, index) => (
                    <span
                      key={index}
                      className={cn(
                        "h-1 w-8 transition-colors duration-500",
                        index < limit.used ? "bg-primary" : "bg-border",
                      )}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {callback && (
          <div
            className={cn(
              "mt-6 flex items-start justify-between gap-3 border px-4 py-3 text-sm duration-300 animate-in fade-in-0 slide-in-from-top-2",
              callback.status === "connected"
                ? "border-emerald-500/30 bg-emerald-500/10"
                : "border-destructive/30 bg-destructive/10",
            )}
          >
            <span className="flex items-start gap-2">
              {callback.status === "connected" ? (
                <>
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  Authorization complete — your MCP server is connected.
                </>
              ) : (
                <>
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  {CALLBACK_ERROR_MESSAGES[callback.errorCode ?? ""] ??
                    CALLBACK_ERROR_MESSAGES.callback_failed}
                </>
              )}
            </span>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismissCallback}>
              <X />
            </Button>
          </div>
        )}

        {actionError && (
          <div className="mt-6 flex items-start justify-between gap-3 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm duration-200 animate-in fade-in-0 slide-in-from-top-1">
            <span className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              {actionError}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              onClick={() => setActionError(undefined)}
            >
              <X />
            </Button>
          </div>
        )}

        {query.isError && (
          <p className="mt-6 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
            Unable to load your MCP servers. Refresh the page to try again.
          </p>
        )}

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {query.isPending &&
            Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-52 rounded-none" />
            ))}

          {servers.map((server, index) => (
            <ServerCard
              key={server.id}
              server={server}
              index={index}
              busy={busyServer?.id === server.id ? busyServer.action : undefined}
              lastTest={lastTests[server.id]}
              onTest={() => {
                setActionError(undefined);
                testMutation.mutate(server.id);
              }}
              onEdit={() => {
                setActionError(undefined);
                setEditing(server);
                setDialogOpen(true);
              }}
              onReconnect={() => void reconnect(server)}
              onDisconnect={() => {
                setActionError(undefined);
                deleteMutation.mutate(server.id);
              }}
            />
          ))}

          {!query.isPending && !atLimit && (
            <button
              type="button"
              onClick={() => {
                setActionError(undefined);
                setEditing(undefined);
                setDialogOpen(true);
              }}
              className={cn(
                "group flex min-h-52 flex-col items-center justify-center gap-3 border border-dashed p-6 text-sm text-muted-foreground outline-none",
                "transition-all duration-200 animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-backwards",
                "hover:border-primary/60 hover:bg-primary/5 hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              )}
              style={{ animationDelay: `${Math.min(servers.length, 8) * 60}ms` }}
            >
              <span className="flex size-10 items-center justify-center border bg-background transition-transform duration-200 group-hover:scale-110 group-hover:border-primary/60">
                <Plus className="size-4 transition-transform duration-200 group-hover:rotate-90" />
              </span>
              {servers.length === 0 ? "Connect your first MCP server" : "Connect another server"}
            </button>
          )}

          {!query.isPending && atLimit && (
            <div
              className="flex min-h-52 flex-col items-center justify-center gap-3 border border-dashed p-6 text-center duration-200 animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-backwards"
              style={{ animationDelay: `${Math.min(servers.length, 8) * 60}ms` }}
            >
              <span className="flex size-10 items-center justify-center border bg-background">
                <Server className="size-4 text-muted-foreground" />
              </span>
              <p className="text-sm text-muted-foreground">
                You&apos;ve reached the free limit of {FREE_MCP_SERVER_LIMIT} servers.
              </p>
              <Button asChild size="sm">
                <Link to="/billing" search={{ checkout: undefined }}>
                  <Sparkles className="size-3.5" />
                  Upgrade for unlimited
                </Link>
              </Button>
            </div>
          )}
        </div>

        <ServerFormDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) setEditing(undefined);
          }}
          editing={editing}
          onSaved={() => void invalidate()}
        />
      </section>
    </TooltipProvider>
  );
}
