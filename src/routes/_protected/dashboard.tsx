import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Loader2,
  Pencil,
  Plug,
  PlugZap,
  Plus,
  RefreshCcw,
  Server,
  ShieldCheck,
  TestTube2,
  Unplug,
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

type McpStatus = "connected" | "pending_auth" | "needs_reconnect" | "error" | "disconnected";

interface McpServerSummary {
  id: string;
  name: string;
  serverUrl: string;
  status: McpStatus;
  oauthIssuer: string | null;
  scopes: string | null;
  lastTestStatus: string | null;
  lastError: string | null;
  lastTestAt: string | null;
  connectedAt: string | null;
  updatedAt: string;
}

interface McpDashboardSummary {
  plan: "free" | "pro_monthly";
  limit: number | null;
  activeCount: number;
  remaining: number | null;
  servers: McpServerSummary[];
}

interface DiscoveryPreview {
  serverUrl: string;
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopesSupported: string[];
}

interface DialogState {
  mode: "connect" | "edit";
  server?: McpServerSummary;
}

export const Route = createFileRoute("/_protected/dashboard")({
  validateSearch: (search: Record<string, unknown>) => ({
    mcp: search.mcp === "connected" || search.mcp === "error" ? search.mcp : undefined,
    message: typeof search.message === "string" ? search.message : undefined,
  }),
  component: Dashboard,
});

const STATUS_COPY: Record<McpStatus, { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "border-primary/40 bg-primary/10 text-primary" },
  pending_auth: {
    label: "Authenticating",
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-700",
  },
  needs_reconnect: {
    label: "Reconnect",
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-700",
  },
  error: { label: "Attention", tone: "border-destructive/40 bg-destructive/10 text-destructive" },
  disconnected: {
    label: "Disconnected",
    tone: "border-muted-foreground/30 bg-muted text-muted-foreground",
  },
};

function Dashboard() {
  const search = Route.useSearch();
  const [summary, setSummary] = useState<McpDashboardSummary>();
  const [dialog, setDialog] = useState<DialogState>();
  const [pageError, setPageError] = useState<string>();
  const [pendingAction, setPendingAction] = useState<string>();

  async function loadMcpServers() {
    const response = await fetch("/api/mcp/servers");
    if (!response.ok) throw new Error("Unable to load MCP servers");
    setSummary((await response.json()) as McpDashboardSummary);
  }

  useEffect(() => {
    void loadMcpServers().catch((reason: unknown) => {
      setPageError(reason instanceof Error ? reason.message : "Unable to load MCP servers");
    });
  }, []);

  async function runServerAction(
    server: McpServerSummary,
    action: "test" | "disconnect" | "reconnect",
  ) {
    setPageError(undefined);
    setPendingAction(`${action}:${server.id}`);
    try {
      if (action === "reconnect") {
        const result = await postJson<{ authorizationUrl?: string; error?: string }>(
          "/api/mcp/auth/start",
          {
            name: server.name,
            serverUrl: server.serverUrl,
            scopes: server.scopes ?? undefined,
            serverId: server.id,
          },
        );
        if (!result.authorizationUrl) throw new Error("Unable to open MCP authorization");
        window.location.assign(result.authorizationUrl);
        return;
      }

      await postJson(`/api/mcp/servers/${action}`, { id: server.id });
      await loadMcpServers();
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : `Unable to ${action} MCP server`);
    } finally {
      setPendingAction(undefined);
    }
  }

  const isAtFreeLimit = summary?.limit !== null && (summary?.remaining ?? 0) <= 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">MCP control</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Connect MCP servers for workflow automation and make them available to chat sessions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/billing" search={{ checkout: undefined }}>
              <CreditCard className="size-4" />
              Billing
            </Link>
          </Button>
          <Button onClick={() => setDialog({ mode: "connect" })} disabled={isAtFreeLimit}>
            <Plus className="size-4 transition-transform group-hover/button:rotate-90" />
            Connect server
          </Button>
        </div>
      </div>

      {search.mcp === "connected" && (
        <Feedback tone="success">MCP server connected. It is ready for chat sessions.</Feedback>
      )}
      {search.mcp === "error" && (
        <Feedback tone="error">
          {search.message ?? "Unable to complete MCP authorization."}
        </Feedback>
      )}
      {pageError && <Feedback tone="error">{pageError}</Feedback>}

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <Card className="transition-colors hover:border-primary/50">
          <CardHeader>
            <CardDescription>Plan</CardDescription>
            <CardTitle className="text-2xl">
              {summary?.plan === "pro_monthly" ? "Pro" : "Free"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge>
              {summary?.limit === null
                ? "Unlimited MCP servers"
                : `${summary?.activeCount ?? 0} of ${summary?.limit ?? 3} servers used`}
            </Badge>
          </CardContent>
        </Card>
        <Card className="transition-colors hover:border-primary/50">
          <CardHeader>
            <CardDescription>Available connections</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <PlugZap className="size-5 text-primary" />
              {summary?.remaining === null ? "Unlimited" : (summary?.remaining ?? "...")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Limits are enforced server-side with billing entitlements.
          </CardContent>
        </Card>
        <Card className="transition-colors hover:border-primary/50">
          <CardHeader>
            <CardDescription>Security</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-5 text-primary" />
              OAuth credentials encrypted
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Tokens stay on the server and are never returned to the browser.
          </CardContent>
        </Card>
      </div>

      <section className="mt-12">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Servers</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">Configured MCP servers</h2>
          </div>
          {summary && summary.limit !== null && summary.remaining === 0 && (
            <Button asChild variant="outline">
              <Link to="/billing" search={{ checkout: undefined }}>
                Upgrade
              </Link>
            </Button>
          )}
        </div>

        {!summary ? (
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Card key={index} className="h-52 animate-pulse bg-muted/40" />
            ))}
          </div>
        ) : summary.servers.length === 0 ? (
          <EmptyMcpState
            onConnect={() => setDialog({ mode: "connect" })}
            disabled={isAtFreeLimit}
          />
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {summary.servers.map((server) => (
              <McpServerCard
                key={server.id}
                server={server}
                pendingAction={pendingAction}
                onEdit={() => setDialog({ mode: "edit", server })}
                onAction={runServerAction}
              />
            ))}
          </div>
        )}
      </section>

      <McpServerDialog
        dialog={dialog}
        limitReached={isAtFreeLimit && dialog?.mode === "connect"}
        onClose={() => setDialog(undefined)}
        onSaved={loadMcpServers}
      />
    </div>
  );
}

function Feedback({ children, tone }: { children: React.ReactNode; tone: "success" | "error" }) {
  return (
    <p
      className={
        tone === "success"
          ? "mt-6 border border-primary/30 bg-primary/10 px-4 py-3 text-sm"
          : "mt-6 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
      }
    >
      {children}
    </p>
  );
}

function EmptyMcpState({ disabled, onConnect }: { disabled: boolean; onConnect: () => void }) {
  return (
    <div className="mt-4 border bg-card px-6 py-12 text-center">
      <Server className="mx-auto size-8 text-primary" />
      <h3 className="mt-4 text-lg font-semibold tracking-tight">No MCP servers connected</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Add a secure OAuth-backed MCP endpoint to make automation tools available in chat.
      </p>
      <Button className="mt-6" onClick={onConnect} disabled={disabled}>
        <Plus className="size-4" />
        Connect server
      </Button>
    </div>
  );
}

function McpServerCard({
  pendingAction,
  server,
  onAction,
  onEdit,
}: {
  pendingAction?: string;
  server: McpServerSummary;
  onAction: (
    server: McpServerSummary,
    action: "test" | "disconnect" | "reconnect",
  ) => Promise<void>;
  onEdit: () => void;
}) {
  const status = STATUS_COPY[server.status];
  const isPending = (action: string) => pendingAction === `${action}:${server.id}`;

  return (
    <Card className="group/card min-h-64 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{server.name}</CardTitle>
            <CardDescription className="mt-1 truncate">
              {new URL(server.serverUrl).host}
            </CardDescription>
          </div>
          <Badge className={status.tone}>{status.label}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
              OAuth issuer
            </dt>
            <dd className="mt-1 truncate">{server.oauthIssuer ?? "Not discovered"}</dd>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                Last test
              </dt>
              <dd className="mt-1">{formatTestState(server)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Updated</dt>
              <dd className="mt-1">{formatDate(server.updatedAt)}</dd>
            </div>
          </div>
        </dl>

        {server.lastError && (
          <p className="mt-4 flex gap-2 border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{server.lastError}</span>
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onAction(server, "test")}
            disabled={server.status !== "connected" || isPending("test")}
          >
            {isPending("test") ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <TestTube2 className="size-4" />
            )}
            Test
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="size-4" />
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onAction(server, "reconnect")}
            disabled={isPending("reconnect")}
          >
            {isPending("reconnect") ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCcw className="size-4 transition-transform group-hover/card:rotate-45" />
            )}
            Reconnect
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void onAction(server, "disconnect")}
            disabled={server.status === "disconnected" || isPending("disconnect")}
          >
            {isPending("disconnect") ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Unplug className="size-4" />
            )}
            Disconnect
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function McpServerDialog({
  dialog,
  limitReached,
  onClose,
  onSaved,
}: {
  dialog?: DialogState;
  limitReached: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [scopes, setScopes] = useState("");
  const [discovery, setDiscovery] = useState<DiscoveryPreview>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<"discover" | "save" | "auth">();
  const isEdit = dialog?.mode === "edit";

  useEffect(() => {
    setName(dialog?.server?.name ?? "");
    setServerUrl(dialog?.server?.serverUrl ?? "");
    setScopes(dialog?.server?.scopes ?? "");
    setDiscovery(undefined);
    setError(undefined);
    setPending(undefined);
  }, [dialog]);

  const canSubmit = useMemo(
    () => name.trim().length >= 2 && serverUrl.trim().length > 0,
    [name, serverUrl],
  );

  async function discover() {
    setError(undefined);
    setPending("discover");
    try {
      setDiscovery(await postJson<DiscoveryPreview>("/api/mcp/discover", { serverUrl }));
    } catch (reason) {
      setDiscovery(undefined);
      setError(reason instanceof Error ? reason.message : "Unable to discover OAuth metadata");
    } finally {
      setPending(undefined);
    }
  }

  async function saveEdit() {
    if (!dialog?.server) return;
    setError(undefined);
    setPending("save");
    try {
      await patchJson("/api/mcp/servers/update", { id: dialog.server.id, name, serverUrl });
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update MCP server");
    } finally {
      setPending(undefined);
    }
  }

  async function authenticate() {
    setError(undefined);
    setPending("auth");
    try {
      const result = await postJson<{ authorizationUrl?: string }>("/api/mcp/auth/start", {
        name,
        serverUrl,
        scopes: scopes.trim() || undefined,
        serverId: dialog?.server?.id,
      });
      if (!result.authorizationUrl) throw new Error("Unable to open MCP authorization");
      window.location.assign(result.authorizationUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to start MCP authorization");
      setPending(undefined);
    }
  }

  return (
    <Dialog open={!!dialog} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit MCP server" : "Connect MCP server"}</DialogTitle>
          <DialogDescription>
            Configure the server URL, verify OAuth discovery, then authenticate with the MCP server.
          </DialogDescription>
        </DialogHeader>

        {limitReached && (
          <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Free accounts can connect 3 MCP servers. Disconnect one or upgrade to Pro.
          </p>
        )}
        {error && (
          <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Workspace tools"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mcp-url">Server URL</Label>
            <Input
              id="mcp-url"
              value={serverUrl}
              onChange={(event) => {
                setServerUrl(event.target.value);
                setDiscovery(undefined);
              }}
              placeholder="https://mcp.example.com"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mcp-scopes">OAuth scopes</Label>
            <Input
              id="mcp-scopes"
              value={scopes}
              onChange={(event) => setScopes(event.target.value)}
              placeholder="mcp:tools"
            />
          </div>
        </div>

        {discovery && (
          <div className="animate-in fade-in-0 zoom-in-95 border bg-muted/40 p-3 text-sm duration-150">
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="size-4 text-primary" />
              OAuth discovery verified
            </p>
            <dl className="mt-3 space-y-2 text-xs">
              <div>
                <dt className="text-muted-foreground">Authorization</dt>
                <dd className="truncate">{discovery.authorizationEndpoint}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Token endpoint</dt>
                <dd className="truncate">{discovery.tokenEndpoint}</dd>
              </div>
            </dl>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={!!pending}>
            Cancel
          </Button>
          {isEdit && (
            <Button
              variant="outline"
              onClick={() => void saveEdit()}
              disabled={!canSubmit || !!pending}
            >
              {pending === "save" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Pencil className="size-4" />
              )}
              Save
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => void discover()}
            disabled={!serverUrl || !!pending}
          >
            {pending === "discover" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plug className="size-4" />
            )}
            Discover OAuth
          </Button>
          <Button
            onClick={() => void authenticate()}
            disabled={!canSubmit || limitReached || !!pending}
          >
            {pending === "auth" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ShieldCheck className="size-4" />
            )}
            Authenticate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function postJson<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonResponse<T>(response);
}

async function patchJson<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonResponse<T>(response);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Unable to complete request");
  return result as T;
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTestState(server: McpServerSummary) {
  if (server.lastTestStatus === "ok") return "Passed";
  if (server.lastTestStatus === "failed") return "Failed";
  return "Not run";
}
