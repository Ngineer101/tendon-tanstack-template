import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  CircleSlash,
  Clock,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Unplug,
  Zap,
} from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { cn } from "#/lib/utils";

type McpStatus = "pending" | "connected" | "error" | "disconnected";

interface McpMetadata {
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  scopesSupported?: string[];
}

interface McpServerInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

interface SafeMcpServer {
  id: string;
  name: string;
  url: string;
  status: McpStatus;
  metadata: McpMetadata | null;
  serverInfo: McpServerInfo | null;
  lastError: string | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ServersResponse {
  servers: SafeMcpServer[];
  limit: number | null;
  pro: boolean;
  count: number;
}

interface DiscoverResponse {
  url: string;
  requiresAuth: boolean;
  discoveryError: string | null;
  metadata: McpMetadata | null;
}

type DialogStep = "form" | "discovering" | "review" | "creating" | "auth";

export function McpServers() {
  const [data, setData] = useState<ServersResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState<{
    kind: "success" | "error" | "info";
    message: string;
  } | null>(null);

  // Connect dialog state
  const [step, setStep] = useState<DialogStep>("form");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [discovered, setDiscovered] = useState<DiscoverResponse | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/mcp/servers");
      if (response.status === 401) {
        setLoadError("You need to be signed in to manage MCP servers.");
        return;
      }
      if (!response.ok) throw new Error("Unable to load MCP servers");
      setData((await response.json()) as ServersResponse);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "Unable to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Surface OAuth callback result once on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mcp = params.get("mcp");
    if (mcp === "connected") {
      setToast({ kind: "success", message: "MCP server connected. You can now use it in chat." });
    } else if (mcp === "error") {
      const reason = params.get("reason");
      setToast({
        kind: "error",
        message: reason ? `Connection failed: ${reason}` : "Connection failed.",
      });
    }
    if (mcp) {
      const next = new URL(window.location.href);
      next.searchParams.delete("mcp");
      next.searchParams.delete("reason");
      window.history.replaceState(null, "", next.pathname + (next.search ? next.search : ""));
    }
  }, []);

  function flashToast(kind: "success" | "error" | "info", message: string) {
    setToast({ kind, message });
    window.setTimeout(() => setToast(null), 4000);
  }

  function resetDialog() {
    setStep("form");
    setName("");
    setUrl("");
    setDiscovered(null);
    setDiscoverError(null);
    setFormError(null);
  }

  function openDialog() {
    resetDialog();
    setDialogOpen(true);
  }

  async function handleDiscover(e: React.FormEvent) {
    e.preventDefault();
    setDiscoverError(null);
    setFormError(null);
    if (!name.trim()) {
      setFormError("Give this server a name.");
      return;
    }
    if (!url.trim()) {
      setFormError("Enter the server URL.");
      return;
    }
    setStep("discovering");
    try {
      const response = await fetch("/api/mcp/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const result = (await response.json()) as DiscoverResponse & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to discover this server");
      setDiscovered(result);
      setStep("review");
    } catch (reason) {
      setDiscoverError(reason instanceof Error ? reason.message : "Unable to discover this server");
      setStep("form");
    }
  }

  async function handleCreate() {
    setStep("creating");
    try {
      const response = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, url }),
      });
      const result = (await response.json()) as {
        server?: SafeMcpServer;
        requiresAuth?: boolean;
        error?: string;
      };
      if (!response.ok || !result.server)
        throw new Error(result.error ?? "Unable to add this server");
      await load();
      if (result.requiresAuth && discovered?.requiresAuth) {
        setStep("auth");
        const authResponse = await fetch(`/api/mcp/servers/${result.server.id}/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const auth = (await authResponse.json()) as { authorizationUrl?: string; error?: string };
        if (!authResponse.ok || !auth.authorizationUrl) {
          throw new Error(auth.error ?? "Unable to start authorization");
        }
        setDialogOpen(false);
        window.location.assign(auth.authorizationUrl);
        return;
      }
      flashToast("success", "Server added. Test the connection to confirm it works.");
      setDialogOpen(false);
    } catch (reason) {
      setStep("review");
      setDiscoverError(reason instanceof Error ? reason.message : "Unable to add this server");
    }
  }

  async function runAction(
    path: string,
    options: { method?: string; body?: unknown; success?: string } = {},
  ) {
    try {
      const response = await fetch(path, {
        method: options.method ?? "POST",
        headers: options.body ? { "content-type": "application/json" } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string; ok?: boolean };
      if (!response.ok) throw new Error(result.error ?? "Action failed");
      if (options.success) flashToast("success", options.success);
      await load();
      return result;
    } catch (reason) {
      flashToast("error", reason instanceof Error ? reason.message : "Action failed");
      return null;
    }
  }

  async function handleTest(server: SafeMcpServer) {
    flashToast("info", `Testing ${server.name}...`);
    const result = await runAction(`/api/mcp/servers/${server.id}/test`, {
      success: `${server.name} responded successfully.`,
    });
    void result;
  }

  async function handleAuth(server: SafeMcpServer) {
    const result = await runAction(`/api/mcp/servers/${server.id}/connect`, {
      method: "POST",
    });
    const auth = result as { authorizationUrl?: string } | null;
    if (auth?.authorizationUrl) {
      window.location.assign(auth.authorizationUrl);
    }
  }

  async function handleReconnect(server: SafeMcpServer) {
    const result = await runAction(`/api/mcp/servers/${server.id}/reconnect`, {
      method: "POST",
    });
    const auth = result as { authorizationUrl?: string } | null;
    if (auth?.authorizationUrl) {
      window.location.assign(auth.authorizationUrl);
    }
  }

  async function handleDisconnect(server: SafeMcpServer) {
    if (
      !window.confirm(
        `Disconnect ${server.name}? Stored credentials will be removed, but the server stays configured so you can reconnect later.`,
      )
    ) {
      return;
    }
    await runAction(`/api/mcp/servers/${server.id}/disconnect`, {
      method: "POST",
      success: `${server.name} disconnected. Reconnect any time to re-authenticate.`,
    });
  }

  async function handleRemove(server: SafeMcpServer) {
    if (
      !window.confirm(
        `Permanently remove ${server.name}? This deletes the server and its configuration.`,
      )
    ) {
      return;
    }
    await runAction(`/api/mcp/servers/${server.id}`, {
      method: "DELETE",
      success: `${server.name} removed.`,
    });
  }

  const buttonsDisabled = step === "discovering" || step === "creating";

  return (
    <section className="mt-12">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Integrations</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">MCP servers</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Connect Model Context Protocol servers to use their tools in your chat sessions. Free
            plans can connect up to 3 servers; Pro unlocks unlimited.
          </p>
        </div>
        <Button
          onClick={openDialog}
          disabled={!data || (data.limit !== null && data.count >= data.limit)}
        >
          <Plus className="size-4" />
          Connect server
        </Button>
      </div>

      {toast && (
        <div
          role="status"
          className={cn(
            "mt-6 flex items-center gap-2 border px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-1 duration-200",
            toast.kind === "success" && "border-primary/30 bg-primary/10 text-foreground",
            toast.kind === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
            toast.kind === "info" && "border-border bg-muted text-muted-foreground",
          )}
        >
          {toast.kind === "success" && <CheckCircle2 className="size-4" />}
          {toast.kind === "error" && <CircleAlert className="size-4" />}
          <span>{toast.message}</span>
        </div>
      )}

      {loadError && (
        <p className="mt-6 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {loadError}
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {loading && !data ? (
          <McpSkeleton />
        ) : !data || data.servers.length === 0 ? (
          <McpEmpty />
        ) : (
          data.servers.map((server, index) => (
            <McpServerCard
              key={server.id}
              server={server}
              index={index}
              onTest={handleTest}
              onAuth={handleAuth}
              onReconnect={handleReconnect}
              onDisconnect={handleDisconnect}
              onRemove={handleRemove}
            />
          ))
        )}
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) resetDialog();
          setDialogOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect an MCP server</DialogTitle>
            <DialogDescription>
              Enter the server URL. We&apos;ll discover its OAuth metadata, then send you to the
              server to approve access.
            </DialogDescription>
          </DialogHeader>

          {step === "form" && (
            <form onSubmit={handleDiscover} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-name">Name</Label>
                <Input
                  id="mcp-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. GitHub MCP"
                  maxLength={80}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mcp-url">Server URL</Label>
                <Input
                  id="mcp-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {(formError || discoverError) && (
                <p className="text-xs text-destructive animate-in fade-in slide-in-from-bottom-1 duration-150">
                  {formError ?? discoverError}
                </p>
              )}
              <DialogFooter showCloseButton>
                <Button type="submit" disabled={buttonsDisabled}>
                  <Zap className="size-4" />
                  Discover
                </Button>
              </DialogFooter>
            </form>
          )}

          {step === "discovering" && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Loader2 className="size-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                Contacting server and reading OAuth metadata...
              </p>
            </div>
          )}

          {step === "review" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{name}</span>
                  {discovered?.requiresAuth ? (
                    <Badge className="border-primary/40 bg-primary/10 text-primary">OAuth</Badge>
                  ) : (
                    <Badge>No auth</Badge>
                  )}
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground" title={discovered?.url}>
                  {discovered?.url ?? url}
                </p>
                {discovered?.discoveryError && (
                  <p className="mt-2 text-xs text-muted-foreground">{discovered.discoveryError}</p>
                )}
                {discovered?.metadata?.scopesSupported?.length ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Scopes: {discovered.metadata.scopesSupported.join(" ")}
                  </p>
                ) : null}
              </div>
              {discoverError && (
                <p className="text-xs text-destructive animate-in fade-in slide-in-from-bottom-1 duration-150">
                  {discoverError}
                </p>
              )}
              <DialogFooter showCloseButton>
                <Button variant="ghost" onClick={() => setStep("form")}>
                  Back
                </Button>
                <Button onClick={() => void handleCreate()}>
                  <PlugZap className="size-4" />
                  {discovered?.requiresAuth ? "Connect & authenticate" : "Connect"}
                </Button>
              </DialogFooter>
            </div>
          )}

          {step === "creating" && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Loader2 className="size-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Saving server...</p>
            </div>
          )}

          {step === "auth" && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Loader2 className="size-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                Sending you to the server to approve access...
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function McpSkeleton() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="border bg-card p-6">
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="mt-3 h-3 w-3/4 animate-pulse rounded bg-muted" />
          <div className="mt-6 h-8 w-full animate-pulse rounded bg-muted" />
        </div>
      ))}
    </>
  );
}

function McpEmpty() {
  return (
    <div className="border border-dashed bg-card/50 p-10 text-center sm:col-span-2 lg:col-span-3">
      <Server className="mx-auto size-8 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">No MCP servers connected yet</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Connect your first server to bring its tools into your chat sessions.
      </p>
    </div>
  );
}

interface McpServerCardProps {
  server: SafeMcpServer;
  index: number;
  onTest: (server: SafeMcpServer) => void;
  onAuth: (server: SafeMcpServer) => void;
  onReconnect: (server: SafeMcpServer) => void;
  onDisconnect: (server: SafeMcpServer) => void;
  onRemove: (server: SafeMcpServer) => void;
}

function McpServerCard({
  server,
  index,
  onTest,
  onAuth,
  onReconnect,
  onDisconnect,
  onRemove,
}: McpServerCardProps) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(server.name);
  const [editUrl, setEditUrl] = useState(server.url);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    setEditName(server.name);
    setEditUrl(server.url);
  }, [server.name, server.url]);

  async function patchServer() {
    setEditError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/mcp/servers/${server.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: editName, url: editUrl }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to save changes");
      setEditing(false);
    } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : "Unable to save changes");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      className={cn(
        "flex flex-col transition-colors duration-200 hover:border-primary/40 animate-in fade-in slide-in-from-bottom-2 duration-300",
        server.status === "error" && "border-destructive/40",
        server.status === "disconnected" && "opacity-80",
      )}
      style={{ animationDelay: `${Math.min(index * 60, 360)}ms` }}
    >
      <CardHeader className="gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <StatusIcon status={server.status} />
            <span className="truncate">{server.name}</span>
          </CardTitle>
          <StatusBadge status={server.status} />
        </div>
        <CardDescription className="truncate" title={server.url}>
          {server.url}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        {editing ? (
          <div className="flex flex-col gap-2 animate-in fade-in slide-in-from-top-1 duration-150">
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Name"
              autoFocus
            />
            <Input
              value={editUrl}
              onChange={(e) => setEditUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              spellCheck={false}
            />
            {editError && (
              <p className="text-xs text-destructive animate-in fade-in slide-in-from-bottom-1 duration-150">
                {editError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="xs" disabled={busy} onClick={() => void patchServer()}>
                {busy ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-3" />
                )}
                Save
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setEditError(null);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
            <div className="mt-2 border-t pt-2">
              <Button
                size="xs"
                variant="destructive"
                onClick={() => onRemove(server)}
                disabled={busy}
              >
                <Trash2 className="size-3" />
                Remove server
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground">
              {server.serverInfo?.name && (
                <p>
                  <span className="font-medium text-foreground">{server.serverInfo.name}</span>
                  {server.serverInfo.version ? ` v${server.serverInfo.version}` : ""}
                </p>
              )}
              {server.lastTestedAt && (
                <p>Last tested {new Date(server.lastTestedAt).toLocaleString()}</p>
              )}
            </div>
            {server.lastError && (
              <p className="text-xs text-destructive line-clamp-3" title={server.lastError}>
                {server.lastError}
              </p>
            )}
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
              <Button
                size="xs"
                variant="outline"
                onClick={() => onTest(server)}
                disabled={busy}
                className="transition-transform active:scale-95"
              >
                <Zap className="size-3" />
                Test
              </Button>
              {server.status !== "connected" && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onAuth(server)}
                  disabled={busy}
                  className="transition-transform active:scale-95"
                >
                  <PlugZap className="size-3" />
                  Connect
                </Button>
              )}
              {server.status === "connected" ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onDisconnect(server)}
                  disabled={busy}
                  className="transition-transform active:scale-95"
                >
                  <Unplug className="size-3" />
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onReconnect(server)}
                  disabled={busy}
                  className="transition-transform active:scale-95"
                >
                  <RefreshCw className="size-3" />
                  Reconnect
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setEditing(true)}
                disabled={busy}
                className="transition-transform active:scale-95"
              >
                <Pencil className="size-3" />
                Edit
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatusIcon({ status }: { status: McpStatus }) {
  if (status === "connected") return <CheckCircle2 className="size-4 text-primary" />;
  if (status === "error") return <CircleAlert className="size-4 text-destructive" />;
  if (status === "pending") return <Clock className="size-4 text-muted-foreground" />;
  return <CircleSlash className="size-4 text-muted-foreground" />;
}

function StatusBadge({ status }: { status: McpStatus }) {
  if (status === "connected")
    return <Badge className="border-primary/40 bg-primary/10 text-primary">Connected</Badge>;
  if (status === "error")
    return (
      <Badge className="border-destructive/30 bg-destructive/10 text-destructive">Error</Badge>
    );
  if (status === "pending") return <Badge className="text-muted-foreground">Awaiting auth</Badge>;
  return <Badge className="text-muted-foreground">Disconnected</Badge>;
}
