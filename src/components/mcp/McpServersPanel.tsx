import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Pencil,
  Plug,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Trash2,
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

type McpStatus = "connected" | "needs_reconnect" | "error" | "disconnected";

interface McpServer {
  id: string;
  name: string;
  serverUrl: string;
  status: McpStatus;
  oauthIssuer: string | null;
  scopes: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface McpSummary {
  plan: "free" | "pro_monthly";
  limit: number | null;
  activeCount: number;
  remaining: number | null;
  servers: McpServer[];
}

interface DiscoveryResult {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationAvailable: boolean;
  scopesSupported: string[];
}

interface FormState {
  name: string;
  serverUrl: string;
  scope: string;
}

const emptyForm: FormState = {
  name: "",
  serverUrl: "",
  scope: "openid profile offline_access",
};

const statusCopy: Record<McpStatus, { label: string; className: string }> = {
  connected: {
    label: "Connected",
    className: "border-primary/40 bg-primary/10 text-primary",
  },
  needs_reconnect: {
    label: "Reconnect",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  error: {
    label: "Error",
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  disconnected: {
    label: "Disconnected",
    className: "border-muted-foreground/30 bg-muted text-muted-foreground",
  },
};

export function McpServersPanel({
  oauthMessage,
}: {
  oauthMessage?: { type: "connected" | "error" | "resume"; message?: string };
}) {
  const [summary, setSummary] = useState<McpSummary>();
  const [loadError, setLoadError] = useState<string>();
  const [dialogMode, setDialogMode] = useState<"connect" | "edit" | "reconnect" | undefined>();
  const [selectedServer, setSelectedServer] = useState<McpServer>();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [discovery, setDiscovery] = useState<DiscoveryResult>();
  const [flowError, setFlowError] = useState<string>();
  const [pending, setPending] = useState<string>();

  const canConnect = summary?.limit === null || (summary?.remaining ?? 0) > 0;
  const dialogTitle = useMemo(() => {
    if (dialogMode === "edit") return "Edit MCP server";
    if (dialogMode === "reconnect") return "Reconnect MCP server";
    return "Connect MCP server";
  }, [dialogMode]);

  async function loadServers() {
    const response = await fetch("/api/mcp/servers");
    const result = (await response.json()) as McpSummary | { error?: string };
    if (!response.ok)
      throw new Error("error" in result ? result.error : "Unable to load MCP servers");
    setSummary(result as McpSummary);
  }

  useEffect(() => {
    void loadServers().catch((reason: unknown) => {
      setLoadError(reason instanceof Error ? reason.message : "Unable to load MCP servers");
    });
  }, []);

  function openConnectDialog() {
    setDialogMode("connect");
    setSelectedServer(undefined);
    setForm(emptyForm);
    setDiscovery(undefined);
    setFlowError(undefined);
  }

  function openEditDialog(server: McpServer) {
    setDialogMode("edit");
    setSelectedServer(server);
    setForm({
      name: server.name,
      serverUrl: server.serverUrl,
      scope: server.scopes ?? emptyForm.scope,
    });
    setDiscovery(undefined);
    setFlowError(undefined);
  }

  function openReconnectDialog(server: McpServer) {
    setDialogMode("reconnect");
    setSelectedServer(server);
    setForm({
      name: server.name,
      serverUrl: server.serverUrl,
      scope: server.scopes ?? emptyForm.scope,
    });
    setDiscovery(undefined);
    setFlowError(undefined);
  }

  async function discoverOAuth() {
    setPending("discover");
    setFlowError(undefined);
    setDiscovery(undefined);
    try {
      const response = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "discover", serverUrl: form.serverUrl }),
      });
      const result = (await response.json()) as DiscoveryResult | { error?: string };
      if (!response.ok)
        throw new Error("error" in result ? result.error : "OAuth discovery failed");
      setDiscovery(result as DiscoveryResult);
    } catch (reason) {
      setFlowError(reason instanceof Error ? reason.message : "OAuth discovery failed");
    } finally {
      setPending(undefined);
    }
  }

  async function submitDialog() {
    if (dialogMode === "edit" && selectedServer) {
      await saveEdit(selectedServer);
      return;
    }

    setPending("connect");
    setFlowError(undefined);
    try {
      const reconnect = dialogMode === "reconnect" && selectedServer;
      const response = await fetch(
        reconnect
          ? `/api/mcp/servers/${encodeURIComponent(selectedServer.id)}/reconnect`
          : "/api/mcp/servers",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "connect", ...form }),
        },
      );
      const result = (await response.json()) as { authorizationUrl?: string; error?: string };
      if (!response.ok || !result.authorizationUrl) {
        throw new Error(result.error ?? "Unable to start MCP authorization");
      }
      window.location.assign(result.authorizationUrl);
    } catch (reason) {
      setFlowError(reason instanceof Error ? reason.message : "Unable to start MCP authorization");
      setPending(undefined);
    }
  }

  async function saveEdit(server: McpServer) {
    setPending(`edit:${server.id}`);
    setFlowError(undefined);
    try {
      const response = await fetch(`/api/mcp/servers/${encodeURIComponent(server.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to update MCP server");
      setDialogMode(undefined);
      await loadServers();
    } catch (reason) {
      setFlowError(reason instanceof Error ? reason.message : "Unable to update MCP server");
    } finally {
      setPending(undefined);
    }
  }

  async function runServerAction(server: McpServer, action: "test" | "disconnect") {
    const actionKey = `${action}:${server.id}`;
    setPending(actionKey);
    setLoadError(undefined);
    try {
      const response = await fetch(
        action === "test"
          ? `/api/mcp/servers/${encodeURIComponent(server.id)}/test`
          : `/api/mcp/servers/${encodeURIComponent(server.id)}`,
        {
          method: action === "test" ? "POST" : "DELETE",
          headers: { "content-type": "application/json" },
        },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Unable to ${action} MCP server`);
      await loadServers();
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : `Unable to ${action} MCP server`);
    } finally {
      setPending(undefined);
    }
  }

  return (
    <section className="mt-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">MCP servers</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">Workflow connectors</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Connect OAuth-enabled MCP servers and make them available to authenticated chat
            sessions.
          </p>
        </div>
        <Button onClick={openConnectDialog} disabled={!canConnect}>
          <PlugZap className="size-4" />
          Connect server
        </Button>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
        <Badge>{summary?.plan === "pro_monthly" ? "Pro" : "Free"} plan</Badge>
        <span className="text-muted-foreground">
          {summary?.limit === null
            ? "Unlimited MCP servers"
            : `${summary?.activeCount ?? 0}/${summary?.limit ?? 3} connected`}
        </span>
        {summary?.remaining === 0 && (
          <Button asChild variant="link" className="h-auto px-0">
            <a href="/billing">Upgrade for unlimited servers</a>
          </Button>
        )}
      </div>

      {oauthMessage?.type === "connected" && (
        <Feedback className="mt-5 border-primary/30 bg-primary/10 text-primary">
          MCP server connected. It is ready for future chat sessions.
        </Feedback>
      )}
      {oauthMessage?.type === "error" && (
        <Feedback className="mt-5 border-destructive/30 bg-destructive/10 text-destructive">
          {oauthMessage.message ?? "Unable to finish MCP authorization."}
        </Feedback>
      )}
      {loadError && (
        <Feedback className="mt-5 border-destructive/30 bg-destructive/10 text-destructive">
          {loadError}
        </Feedback>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {!summary ? (
          Array.from({ length: 3 }).map((_, index) => (
            <Card key={index} className="min-h-56 animate-pulse bg-muted/30" />
          ))
        ) : summary.servers.length ? (
          summary.servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              pending={pending}
              onEdit={() => openEditDialog(server)}
              onReconnect={() => openReconnectDialog(server)}
              onTest={() => void runServerAction(server, "test")}
              onDisconnect={() => void runServerAction(server, "disconnect")}
            />
          ))
        ) : (
          <Card className="border-dashed md:col-span-2 xl:col-span-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plug className="size-5 text-primary" />
                No MCP servers connected
              </CardTitle>
              <CardDescription>
                Add your first server URL, verify OAuth discovery, and authorize access.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={openConnectDialog}>
                <KeyRound className="size-4" />
                Start connection flow
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={!!dialogMode} onOpenChange={(open) => !open && setDialogMode(undefined)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              Configure the MCP server URL, verify OAuth discovery, then authenticate directly with
              the server.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <Field
              label="Display name"
              value={form.name}
              onChange={(name) => setForm({ ...form, name })}
            />
            <Field
              label="Server URL"
              value={form.serverUrl}
              placeholder="https://mcp.example.com"
              onChange={(serverUrl) => {
                setDiscovery(undefined);
                setForm({ ...form, serverUrl });
              }}
            />
            <Field
              label="OAuth scopes"
              value={form.scope}
              onChange={(scope) => setForm({ ...form, scope })}
            />

            <div className="border bg-muted/30 p-3 transition-all duration-200">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 size-4 text-primary" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium">Server-side credential handling</p>
                  <p className="text-muted-foreground">
                    Tokens are exchanged and encrypted on the server. They are never returned to the
                    browser.
                  </p>
                </div>
              </div>
            </div>

            {discovery && (
              <div className="animate-in fade-in-0 slide-in-from-bottom-1 border border-primary/30 bg-primary/10 p-3 text-sm duration-200">
                <p className="flex items-center gap-2 font-medium text-primary">
                  <CheckCircle2 className="size-4" />
                  OAuth discovery succeeded
                </p>
                <dl className="mt-3 grid gap-2 text-xs text-muted-foreground">
                  <MetadataRow label="Issuer" value={discovery.issuer ?? "Not provided"} />
                  <MetadataRow label="Authorization" value={discovery.authorizationEndpoint} />
                  <MetadataRow label="Token" value={discovery.tokenEndpoint} />
                  <MetadataRow
                    label="Registration"
                    value={
                      discovery.registrationAvailable
                        ? "Dynamic registration available"
                        : "Server client ID required"
                    }
                  />
                </dl>
              </div>
            )}

            {flowError && (
              <Feedback className="border-destructive/30 bg-destructive/10 text-destructive">
                {flowError}
              </Feedback>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogMode(undefined)} disabled={!!pending}>
              Cancel
            </Button>
            {dialogMode !== "edit" && (
              <Button variant="outline" onClick={() => void discoverOAuth()} disabled={!!pending}>
                {pending === "discover" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                Discover OAuth
              </Button>
            )}
            <Button onClick={() => void submitDialog()} disabled={!!pending}>
              {pending === "connect" || pending?.startsWith("edit:") ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ExternalLink className="size-4" />
              )}
              {dialogMode === "edit" ? "Save changes" : "Authenticate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ServerCard({
  server,
  pending,
  onEdit,
  onReconnect,
  onTest,
  onDisconnect,
}: {
  server: McpServer;
  pending?: string;
  onEdit: () => void;
  onReconnect: () => void;
  onTest: () => void;
  onDisconnect: () => void;
}) {
  const status = statusCopy[server.status];
  const testing = pending === `test:${server.id}`;
  const disconnecting = pending === `disconnect:${server.id}`;

  return (
    <Card className="group min-h-64 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{server.name}</CardTitle>
            <CardDescription className="mt-1 truncate font-mono text-xs">
              {new URL(server.serverUrl).hostname}
            </CardDescription>
          </div>
          <Badge className={status.className}>{status.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex min-h-40 flex-col justify-between gap-4">
        <div className="space-y-3 text-sm">
          <MetadataRow label="URL" value={server.serverUrl} />
          <MetadataRow label="Issuer" value={server.oauthIssuer ?? "Not discovered"} />
          <MetadataRow
            label="Last test"
            value={
              server.lastTestedAt ? new Date(server.lastTestedAt).toLocaleString() : "Not tested"
            }
          />
          {server.lastError && (
            <p className="flex items-start gap-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5" />
              <span>{server.lastError}</span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onTest}
            disabled={!!pending || server.status === "disconnected"}
          >
            {testing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Test
          </Button>
          <Button size="sm" variant="outline" onClick={onReconnect} disabled={!!pending}>
            <KeyRound className="size-3.5" />
            Reconnect
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} disabled={!!pending}>
            <Pencil className="size-3.5" />
            Edit
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={onDisconnect}
            disabled={!!pending || server.status === "disconnected"}
          >
            {disconnecting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            Disconnect
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-xs">{value}</dd>
    </div>
  );
}

function Feedback({ children, className }: { children: ReactNode; className: string }) {
  return (
    <p
      className={`animate-in fade-in-0 slide-in-from-top-1 border px-4 py-3 text-sm duration-200 ${className}`}
    >
      {children}
    </p>
  );
}
