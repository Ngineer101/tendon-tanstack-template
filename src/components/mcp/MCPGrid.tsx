import { useEffect, useState, useCallback } from "react";
import { Plug2, Server, ShieldAlert } from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { ConnectMCPDialog } from "./ConnectMCPDialog";
import { MCPServerCard, type MCPServerData } from "./MCPServerCard";

interface LimitInfo {
  current: number;
  limit: number | null;
  isPro: boolean;
}

interface MCPGridProps {
  onToast?: (message: string, variant: "success" | "error") => void;
}

export function MCPGrid({ onToast }: MCPGridProps) {
  const [servers, setServers] = useState<MCPServerData[]>([]);
  const [limit, setLimit] = useState<LimitInfo>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create");
  const [editServer, setEditServer] = useState<MCPServerData>();
  const [pending, setPending] = useState<string>();
  const [redirectUrl, setRedirectUrl] = useState<string>();

  const loadServers = useCallback(async () => {
    try {
      const response = await fetch("/api/mcp");
      if (!response.ok) throw new Error("Failed to load servers");
      const data = (await response.json()) as { servers: MCPServerData[]; limit: LimitInfo };
      setServers(data.servers);
      setLimit(data.limit);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load servers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  useEffect(() => {
    if (redirectUrl) {
      window.location.assign(redirectUrl);
    }
  }, [redirectUrl]);

  async function handleConnect(serverId: string) {
    setPending(serverId);
    setError(undefined);
    try {
      const response = await fetch("/api/mcp/oauth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverId }),
      });
      const result = (await response.json()) as { authorizationUrl?: string; error?: string };
      if (!response.ok || !result.authorizationUrl) {
        throw new Error(result.error ?? "Failed to start OAuth flow");
      }
      setRedirectUrl(result.authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start OAuth flow");
      setPending(undefined);
    }
  }

  async function handleTest(serverId: string) {
    setPending(serverId);
    setError(undefined);
    try {
      const response = await fetch("/api/mcp/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverId }),
      });
      const result = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok) throw new Error((result as { error: string }).error ?? "Test failed");

      if (result.success) {
        onToast?.("Connection successful", "success");
      } else {
        onToast?.("Connection failed", "error");
      }
      await loadServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setPending(undefined);
    }
  }

  async function handleEdit(serverId: string) {
    const server = servers.find((s) => s.id === serverId);
    if (server) {
      setEditServer(server);
      setDialogMode("edit");
      setDialogOpen(true);
    }
  }

  async function handleDisconnect(serverId: string) {
    setPending(serverId);
    setError(undefined);
    try {
      const response = await fetch(`/api/mcp/${serverId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disconnect: true }),
      });
      if (!response.ok) {
        const err = (await response.json()) as { error: string };
        throw new Error(err.error ?? "Failed to disconnect");
      }

      await loadServers();
      onToast?.("Server disconnected", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setPending(undefined);
    }
  }

  async function handleDelete(serverId: string) {
    setPending(serverId);
    setError(undefined);
    try {
      const response = await fetch(`/api/mcp/${serverId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete");
      await loadServers();
      onToast?.("Server deleted", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setPending(undefined);
    }
  }

  async function handleSave(data: { name: string; serverUrl: string }) {
    if (dialogMode === "edit" && editServer) {
      const response = await fetch(`/api/mcp/${editServer.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const err = (await response.json()) as { error: string };
        throw new Error(err.error ?? "Failed to update");
      }
    } else {
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const err = (await response.json()) as { error: string };
        throw new Error(err.error ?? "Failed to create");
      }
    }
    await loadServers();
  }

  function canAdd() {
    if (!limit) return false;
    if (limit.isPro) return true;
    return limit.current < (limit.limit ?? 0);
  }

  if (loading) {
    return (
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-44" />
        ))}
      </div>
    );
  }

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-2 duration-500">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <h2 className="font-heading text-xl font-semibold tracking-tight">MCP Servers</h2>
          {limit && (
            <Badge>
              {limit.current}
              {limit.limit ? ` / ${limit.limit}` : ""} connected
              {limit.isPro && <span className="ml-1 text-primary">Pro</span>}
            </Badge>
          )}
        </div>
        <Button
          onClick={() => {
            setDialogMode("create");
            setEditServer(undefined);
            setDialogOpen(true);
          }}
          disabled={!canAdd()}
          size="sm"
        >
          <Plug2 className="size-4" />
          Connect server
        </Button>
      </div>

      <p className="mt-2 text-sm text-muted-foreground">
        Connect MCP servers to extend your application with custom tools and integrations.
        {!limit?.isPro && limit?.current !== undefined && limit.limit !== null && (
          <span className="ml-1">
            Free accounts can connect up to {limit.limit} servers.{" "}
            <span className="font-medium text-primary">Upgrade to Pro for unlimited.</span>
          </span>
        )}
      </p>

      {error && (
        <div className="mt-4 animate-in fade-in-0 slide-in-from-top-1 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <ShieldAlert className="mr-2 inline size-4" />
          {error}
        </div>
      )}

      {servers.length === 0 ? (
        <div className="mt-8 flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 px-4 py-16 text-center">
          <Server className="mb-4 size-12 text-muted-foreground/40" />
          <p className="text-sm font-medium text-muted-foreground">No MCP servers connected</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground/70">
            Connect an MCP server to add custom tools and automations to your workflow.
          </p>
          <Button
            variant="outline"
            className="mt-4"
            size="sm"
            onClick={() => {
              setDialogMode("create");
              setEditServer(undefined);
              setDialogOpen(true);
            }}
            disabled={!canAdd()}
          >
            <Plug2 className="size-4" />
            Add your first server
          </Button>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((server, i) => (
            <div
              key={server.id}
              className="animate-in fade-in-0 slide-in-from-bottom-2"
              style={{
                animationDelay: `${i * 80}ms`,
                animationFillMode: "both",
                animationDuration: "400ms",
              }}
            >
              <MCPServerCard
                server={server}
                onConnect={(id) => {
                  void handleConnect(id);
                }}
                onTest={(id) => {
                  void handleTest(id);
                }}
                onEdit={(id) => {
                  void handleEdit(id);
                }}
                onDisconnect={(id) => {
                  void handleDisconnect(id);
                }}
                onDelete={(id) => {
                  void handleDelete(id);
                }}
                isPending={pending === server.id}
              />
            </div>
          ))}
        </div>
      )}

      <ConnectMCPDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={dialogMode}
        initialName={editServer?.name}
        initialUrl={editServer?.serverUrl}
        onSave={handleSave}
      />
    </div>
  );
}
