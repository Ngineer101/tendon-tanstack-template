import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Plus, Server, X } from "lucide-react";

import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { McpConnectDialog, type ConnectOutcome } from "#/components/mcp/mcp-connect-dialog";
import { McpDisconnectDialog } from "#/components/mcp/mcp-disconnect-dialog";
import { McpServerCard, type ServerCardAction } from "#/components/mcp/mcp-server-card";
import { FREE_MCP_SERVER_LIMIT, type McpServerPublic } from "#/lib/mcp/config";

interface ApiErrorBody {
  error?: string;
  code?: string;
}

async function readApiError(response: Response, fallback: string): Promise<Error> {
  let body: ApiErrorBody = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // Non-JSON error bodies fall through to the fallback message.
  }
  return new Error(body.error ?? fallback);
}

export function McpServersSection({ plan }: { plan: "free" | "pro_monthly" | undefined }) {
  const [servers, setServers] = useState<McpServerPublic[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerPublic | null>(null);
  const [disconnecting, setDisconnecting] = useState<McpServerPublic | null>(null);

  const loadServers = useCallback(async () => {
    const response = await fetch("/api/mcp/servers");
    if (!response.ok) throw await readApiError(response, "Unable to load MCP servers");
    const data = (await response.json()) as { servers: McpServerPublic[] };
    setServers(data.servers);
  }, []);

  useEffect(() => {
    loadServers().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Unable to load MCP servers");
    });
  }, [loadServers]);

  const atLimit = plan !== "pro_monthly" && (servers?.length ?? 0) >= FREE_MCP_SERVER_LIMIT;

  function upsertServer(server: McpServerPublic) {
    setServers((current) => {
      if (!current) return [server];
      const index = current.findIndex((item) => item.id === server.id);
      if (index === -1) return [...current, server];
      const next = [...current];
      next[index] = server;
      return next;
    });
  }

  async function submitConnect(input: { url: string; name?: string }): Promise<ConnectOutcome> {
    const response = await fetch(editing ? `/api/mcp/servers/${editing.id}` : "/api/mcp/servers", {
      method: editing ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const failure = await readApiError(response, "Unable to connect the MCP server");
      return { kind: "error", message: failure.message };
    }
    const result = (await response.json()) as {
      server: McpServerPublic;
      requiresAuth: boolean;
      authorizationUrl?: string;
    };
    upsertServer(result.server);
    if (result.requiresAuth && result.authorizationUrl) {
      return {
        kind: "authorize",
        authorizationUrl: result.authorizationUrl,
        server: result.server,
      };
    }
    return { kind: "connected", server: result.server };
  }

  async function runAction(action: ServerCardAction) {
    setError(undefined);
    setNotice(undefined);

    if (action.kind === "edit") {
      setEditing(action.server);
      setConnectOpen(true);
      return;
    }
    if (action.kind === "disconnect") {
      setDisconnecting(action.server);
      return;
    }

    const key = action.kind;
    setPendingAction(key);
    try {
      const response = await fetch(`/api/mcp/servers/${action.server.id}/${action.kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) {
        throw await readApiError(response, `Unable to ${action.kind} the MCP server`);
      }
      const result = (await response.json()) as {
        server: McpServerPublic;
        requiresAuth?: boolean;
        authorizationUrl?: string;
      };
      upsertServer(result.server);
      if (result.requiresAuth && result.authorizationUrl) {
        window.location.assign(result.authorizationUrl);
        return;
      }
      if (action.kind === "test") {
        setNotice(`${action.server.name} is reachable and responding.`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The action failed");
      await loadServers().catch(() => undefined);
    } finally {
      setPendingAction(null);
    }
  }

  async function confirmDisconnect() {
    if (!disconnecting) return;
    setError(undefined);
    setPendingAction("disconnect");
    try {
      const response = await fetch(`/api/mcp/servers/${disconnecting.id}`, { method: "DELETE" });
      if (!response.ok) {
        throw await readApiError(response, "Unable to disconnect the MCP server");
      }
      setServers((current) => current?.filter((item) => item.id !== disconnecting.id));
      setDisconnecting(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to disconnect the MCP server");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className="mt-12">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">MCP servers</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">Connected tool servers</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Connect Model Context Protocol servers to use their tools in chat sessions. OAuth
            credentials are encrypted at rest and never leave the server.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {servers && (
            <span className="font-mono text-xs text-muted-foreground">
              {plan === "pro_monthly"
                ? `${servers.length} connected`
                : `${servers.length} of ${FREE_MCP_SERVER_LIMIT} used`}
            </span>
          )}
          <Button
            onClick={() => {
              setEditing(null);
              setConnectOpen(true);
            }}
            disabled={atLimit || servers === undefined}
            className="transition-transform active:translate-y-px"
          >
            <Plus className="size-4" />
            Add server
          </Button>
        </div>
      </div>

      {notice && (
        <p className="mt-6 flex items-center justify-between gap-2 border border-primary/30 bg-primary/10 px-4 py-3 text-sm animate-in fade-in-0 slide-in-from-top-1 duration-200">
          {notice}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNotice(undefined)}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </p>
      )}
      {error && (
        <p className="mt-6 flex items-center justify-between gap-2 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm animate-in fade-in-0 slide-in-from-top-1 duration-200">
          {error}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setError(undefined)}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </p>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {servers === undefined ? (
          [0, 1, 2].map((index) => (
            <Skeleton
              key={index}
              className="h-44 w-full animate-pulse"
              style={{ animationDelay: `${index * 80}ms` }}
            />
          ))
        ) : servers.length === 0 ? (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setConnectOpen(true);
            }}
            className="group flex min-h-44 animate-in fade-in-0 flex-col items-center justify-center gap-3 border border-dashed px-6 py-10 text-center transition-colors duration-200 fill-mode-backwards hover:border-primary/50 hover:bg-primary/5 md:col-span-2 lg:col-span-3"
          >
            <span className="flex size-10 items-center justify-center border bg-muted text-muted-foreground transition-all duration-200 group-hover:scale-105 group-hover:border-primary/40 group-hover:text-primary">
              <Server className="size-5" />
            </span>
            <span>
              <span className="block font-medium">No MCP servers yet</span>
              <span className="mt-1 block text-sm text-muted-foreground">
                Connect your first server to automate your workflow with its tools.
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-primary">
              <Plus className="size-4 transition-transform duration-200 group-hover:rotate-90" />
              Connect a server
            </span>
          </button>
        ) : (
          <>
            {servers.map((server, index) => (
              <McpServerCard
                key={server.id}
                server={server}
                pendingAction={pendingAction}
                onAction={(action) => void runAction(action)}
                style={{ animationDelay: `${index * 60}ms` }}
              />
            ))}
            {atLimit ? (
              <Link
                to="/billing"
                search={{ checkout: undefined }}
                className="group flex min-h-44 animate-in fade-in-0 slide-in-from-bottom-2 flex-col items-center justify-center gap-3 border border-dashed border-primary/40 px-6 py-10 text-center transition-colors duration-200 fill-mode-backwards hover:border-primary/60 hover:bg-primary/5"
                style={{ animationDelay: `${servers.length * 60}ms` }}
              >
                <span className="flex size-10 items-center justify-center border border-primary/40 bg-primary/10 text-primary transition-transform duration-200 group-hover:scale-105">
                  <ArrowUpRight className="size-5" />
                </span>
                <span>
                  <span className="block font-medium">Free plan limit reached</span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    Upgrade to Pro for unlimited MCP servers.
                  </span>
                </span>
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setConnectOpen(true);
                }}
                className="group flex min-h-44 animate-in fade-in-0 slide-in-from-bottom-2 flex-col items-center justify-center gap-2 border border-dashed px-6 py-10 text-muted-foreground transition-colors duration-200 fill-mode-backwards hover:border-primary/50 hover:bg-primary/5 hover:text-foreground"
                style={{ animationDelay: `${servers.length * 60}ms` }}
              >
                <Plus className="size-5 transition-transform duration-200 group-hover:rotate-90" />
                <span className="text-sm font-medium">Add another server</span>
              </button>
            )}
          </>
        )}
      </div>

      <McpConnectDialog
        open={connectOpen}
        onOpenChange={(open) => {
          setConnectOpen(open);
          if (!open) setEditing(null);
        }}
        editing={editing}
        onSubmit={submitConnect}
      />
      <McpDisconnectDialog
        server={disconnecting}
        pending={pendingAction === "disconnect"}
        onConfirm={() => void confirmDisconnect()}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
      />
    </section>
  );
}
