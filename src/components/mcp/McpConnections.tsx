import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  CircleOff,
  LoaderCircle,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Unplug,
  Zap,
} from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card } from "#/components/ui/card";
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
import type {
  McpConnectionDto,
  McpConnectionListResponse,
  McpConnectionMutationResponse,
} from "#/lib/mcp/types";
import { cn } from "#/lib/utils";

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Authorization was cancelled. Your server is saved and ready to reconnect.",
  connection_already_exists: "That MCP server is already in your workspace.",
  connection_failed: "The connection could not be completed. Check the endpoint and try again.",
  invalid_callback: "The authorization server returned an incomplete response.",
  invalid_url: "Enter a valid MCP server URL.",
  mcp_reconnect_required: "Authorization expired. Reconnect this server to continue.",
  mcp_server_limit_reached: "Free accounts can connect three servers. Upgrade for unlimited MCP.",
  mcp_test_failed: "The server responded, but the MCP handshake did not complete.",
  mcp_unreachable: "We could not reach that server. Check the URL and try again.",
  oauth_discovery_failed: "OAuth discovery failed. Confirm the server supports remote MCP OAuth.",
  oauth_discovery_incomplete: "The server's OAuth metadata is missing required fields.",
  oauth_discovery_invalid: "The server returned invalid OAuth discovery metadata.",
  oauth_failed: "Authorization did not complete. You can safely try reconnecting.",
  oauth_issuer_mismatch: "The advertised OAuth issuer did not match its signed-in service.",
  oauth_pkce_unsupported: "This server does not advertise the required PKCE security method.",
  oauth_registration_unsupported:
    "This server does not support automatic OAuth client registration.",
  oauth_session_expired: "The authorization window expired. Start reconnecting again.",
  oauth_token_exchange_failed: "The authorization server rejected the final token exchange.",
  oauth_resource_mismatch: "The OAuth resource does not match this MCP server.",
  session_required: "Sign in again before connecting your MCP server.",
  unsafe_url: "For security, MCP servers must use a public HTTPS address on port 443.",
};

type PendingAction = { id: string; action: "test" | "reconnect" | "disconnect" };

function displayError(codeOrMessage?: string) {
  return codeOrMessage ? (ERROR_MESSAGES[codeOrMessage] ?? codeOrMessage) : "Something went wrong.";
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (response.status === 204) return undefined as T;
  const payload = (await response.json()) as T & { error?: string; code?: string };
  if (!response.ok) throw new Error(payload.code ?? payload.error ?? "Unable to complete request");
  return payload;
}

function statusDetails(connection: McpConnectionDto) {
  if (connection.status === "connected") {
    return { label: "Connected", icon: Check, className: "text-emerald-700 dark:text-emerald-400" };
  }
  if (connection.status === "error") {
    return { label: "Needs attention", icon: AlertTriangle, className: "text-destructive" };
  }
  return {
    label: "Awaiting authorization",
    icon: Activity,
    className: "text-amber-700 dark:text-amber-400",
  };
}

function hostname(serverUrl: string) {
  try {
    return new URL(serverUrl).hostname;
  } catch {
    return serverUrl;
  }
}

export function McpConnections({
  oauthStatus,
  oauthError,
}: {
  oauthStatus?: "connected" | "error";
  oauthError?: string;
}) {
  const [data, setData] = useState<McpConnectionListResponse>();
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<
    { kind: "success" | "error"; message: string } | undefined
  >(
    oauthStatus
      ? {
          kind: oauthStatus === "connected" ? "success" : "error",
          message:
            oauthStatus === "connected"
              ? "MCP server connected. It is ready for your chat sessions."
              : displayError(oauthError),
        }
      : undefined,
  );
  const [pending, setPending] = useState<PendingAction>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<McpConnectionDto>();
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [flowStep, setFlowStep] = useState<"details" | "discovering" | "redirecting">("details");
  const [disconnecting, setDisconnecting] = useState<McpConnectionDto>();

  const loadConnections = useCallback(async () => {
    const result = await apiRequest<McpConnectionListResponse>("/api/mcp/connections");
    setData(result);
  }, []);

  useEffect(() => {
    void loadConnections()
      .catch((error: unknown) => {
        setFeedback({
          kind: "error",
          message:
            error instanceof Error ? displayError(error.message) : "Unable to load MCP servers.",
        });
      })
      .finally(() => setLoading(false));
  }, [loadConnections]);

  function openEditor(connection?: McpConnectionDto) {
    setEditing(connection);
    setName(connection?.name ?? "");
    setServerUrl(connection?.serverUrl ?? "");
    setFlowStep("details");
    setEditorOpen(true);
    setFeedback(undefined);
  }

  async function saveConnection() {
    setFeedback(undefined);
    setFlowStep("discovering");
    try {
      const result = await apiRequest<McpConnectionMutationResponse>(
        editing ? `/api/mcp/connections/${editing.id}` : "/api/mcp/connections",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, serverUrl }),
        },
      );
      await loadConnections();
      if (result.authorizationUrl) {
        setFlowStep("redirecting");
        window.location.assign(result.authorizationUrl);
        return;
      }
      setEditorOpen(false);
      setFeedback({
        kind: "success",
        message: result.connected
          ? `${result.connection.name} is connected and ready.`
          : `${result.connection.name} was updated.`,
      });
    } catch (error) {
      setFlowStep("details");
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? displayError(error.message) : "Unable to save this server.",
      });
      await loadConnections().catch(() => undefined);
    }
  }

  async function runAction(connection: McpConnectionDto, action: "test" | "reconnect") {
    setPending({ id: connection.id, action });
    setFeedback(undefined);
    try {
      if (action === "test") {
        await apiRequest(`/api/mcp/connections/${connection.id}/test`, { method: "POST" });
        setFeedback({ kind: "success", message: `${connection.name} passed the MCP handshake.` });
      } else {
        const result = await apiRequest<McpConnectionMutationResponse>(
          `/api/mcp/connections/${connection.id}/oauth/start`,
          { method: "POST" },
        );
        if (result.authorizationUrl) {
          window.location.assign(result.authorizationUrl);
          return;
        }
        setFeedback({ kind: "success", message: `${connection.name} is connected.` });
      }
      await loadConnections();
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error ? displayError(error.message) : "Unable to complete that action.",
      });
      await loadConnections().catch(() => undefined);
    } finally {
      setPending(undefined);
    }
  }

  async function disconnect() {
    if (!disconnecting) return;
    const connection = disconnecting;
    setPending({ id: connection.id, action: "disconnect" });
    setFeedback(undefined);
    try {
      await apiRequest(`/api/mcp/connections/${connection.id}`, { method: "DELETE" });
      setDisconnecting(undefined);
      await loadConnections();
      setFeedback({
        kind: "success",
        message: `${connection.name} was disconnected and its stored credentials were removed.`,
      });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? displayError(error.message) : "Unable to disconnect.",
      });
    } finally {
      setPending(undefined);
    }
  }

  const atLimit =
    !!data && !data.limits.unlimited && data.limits.used >= (data.limits.maximum ?? 0);

  return (
    <section className="mt-10" aria-labelledby="mcp-heading">
      <div className="flex flex-col gap-5 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 text-primary">
            <span className="relative flex size-7 items-center justify-center border border-primary/30 bg-primary/10">
              <Plug className="size-3.5" />
              <span className="absolute -right-1 -top-1 size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
            </span>
            <p className="font-mono text-xs uppercase tracking-[0.2em]">Connected tools</p>
          </div>
          <h2
            id="mcp-heading"
            className="mt-3 font-heading text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            MCP server workspace
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Bring your tools and data into chat. We discover OAuth automatically and keep
            credentials encrypted server-side.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="border bg-muted/35 px-3 py-2 text-right">
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              Capacity
            </p>
            <p className="mt-0.5 text-sm font-semibold">
              {data?.limits.unlimited
                ? `${data.limits.used} · unlimited`
                : `${data?.limits.used ?? 0} / ${data?.limits.maximum ?? 3}`}
            </p>
          </div>
          <Button onClick={() => openEditor()} disabled={atLimit || loading} className="h-10 px-4">
            <Plus className="size-4 transition-transform group-hover/button:rotate-90" />
            Connect server
          </Button>
        </div>
      </div>

      {feedback ? (
        <div
          className={cn(
            "mcp-feedback-enter mt-5 flex items-start gap-3 border px-4 py-3 text-sm",
            feedback.kind === "success"
              ? "border-emerald-500/30 bg-emerald-500/8 text-emerald-800 dark:text-emerald-300"
              : "border-destructive/30 bg-destructive/8 text-destructive",
          )}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.kind === "success" ? (
            <Check className="mt-0.5 size-4" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4" />
          )}
          <span>{feedback.message}</span>
        </div>
      ) : null}

      {atLimit ? (
        <div className="mt-5 flex flex-col gap-3 border border-primary/25 bg-primary/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span>You&apos;ve used all three free MCP connections.</span>
          <Button asChild variant="link" className="h-auto justify-start p-0 sm:justify-center">
            <Link to="/billing" search={{ checkout: undefined }}>
              Upgrade for unlimited <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading
          ? Array.from({ length: 3 }, (_, index) => (
              <div
                key={index}
                className="h-64 animate-pulse border bg-muted/40 motion-reduce:animate-none"
              />
            ))
          : data?.connections.map((connection, index) => {
              const status = statusDetails(connection);
              const StatusIcon = status.icon;
              const isPending = pending?.id === connection.id;
              return (
                <Card
                  key={connection.id}
                  className="mcp-card-enter group relative overflow-hidden p-5 transition-[transform,border-color,box-shadow] duration-300 hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-lg hover:shadow-foreground/5 motion-reduce:transform-none"
                  style={{ animationDelay: `${index * 55}ms` }}
                >
                  <div className="absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-primary transition-transform duration-500 group-hover:scale-x-100 motion-reduce:transition-none" />
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-10 shrink-0 items-center justify-center border bg-muted/50 transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                        <Server className="size-4.5" />
                      </span>
                      <div className="min-w-0">
                        <h3 className="truncate font-heading text-base font-semibold">
                          {connection.name}
                        </h3>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {hostname(connection.serverUrl)}
                        </p>
                      </div>
                    </div>
                    <Badge className={cn("shrink-0 gap-1.5 bg-background", status.className)}>
                      <StatusIcon
                        className={cn(
                          "size-3",
                          connection.status === "pending" &&
                            "animate-pulse motion-reduce:animate-none",
                        )}
                      />
                      {status.label}
                    </Badge>
                  </div>

                  <div className="mt-6 grid grid-cols-2 gap-px border bg-border">
                    <div className="bg-card px-3 py-2.5">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        Authorization
                      </p>
                      <p className="mt-1 flex items-center gap-1.5 text-xs font-medium">
                        <ShieldCheck className="size-3 text-primary" />
                        {connection.authType === "oauth" ? "OAuth 2.1" : "Public endpoint"}
                      </p>
                    </div>
                    <div className="bg-card px-3 py-2.5">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        Last tested
                      </p>
                      <p className="mt-1 text-xs font-medium">
                        {connection.lastTestedAt
                          ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
                              Math.round(
                                (new Date(connection.lastTestedAt).getTime() - Date.now()) /
                                  86_400_000,
                              ),
                              "day",
                            )
                          : "Not yet"}
                      </p>
                    </div>
                  </div>

                  {connection.lastErrorCode ? (
                    <p className="mt-4 line-clamp-2 min-h-10 text-xs leading-5 text-destructive">
                      {displayError(connection.lastErrorCode)}
                    </p>
                  ) : (
                    <p className="mt-4 min-h-10 text-xs leading-5 text-muted-foreground">
                      Available to your authenticated chat sessions.
                    </p>
                  )}

                  <div className="mt-4 flex flex-wrap items-center gap-1 border-t pt-4">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isPending || connection.status !== "connected"}
                      onClick={() => void runAction(connection, "test")}
                    >
                      {isPending && pending.action === "test" ? (
                        <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                      ) : (
                        <Zap />
                      )}
                      Test
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isPending}
                      onClick={() => openEditor(connection)}
                    >
                      <Pencil /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isPending}
                      onClick={() => void runAction(connection, "reconnect")}
                    >
                      {isPending && pending.action === "reconnect" ? (
                        <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                      ) : (
                        <RefreshCw className="transition-transform group-hover/button:rotate-45" />
                      )}
                      Reconnect
                    </Button>
                    <Button
                      className="ml-auto"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Disconnect ${connection.name}`}
                      disabled={isPending}
                      onClick={() => setDisconnecting(connection)}
                    >
                      <Unplug />
                    </Button>
                  </div>
                </Card>
              );
            })}
      </div>

      {!loading && data?.connections.length === 0 ? (
        <button
          type="button"
          onClick={() => openEditor()}
          className="group mt-6 flex w-full flex-col items-center border border-dashed px-6 py-14 text-center transition-colors hover:border-primary/50 hover:bg-primary/[0.025] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="flex size-12 items-center justify-center border bg-muted transition-transform duration-300 group-hover:-translate-y-1 group-hover:bg-primary/10 group-hover:text-primary motion-reduce:transform-none">
            <CircleOff className="size-5" />
          </span>
          <span className="mt-4 font-heading text-base font-semibold">
            No MCP servers connected
          </span>
          <span className="mt-1 max-w-md text-sm text-muted-foreground">
            Add a remote MCP endpoint and we&apos;ll guide you through secure authorization.
          </span>
        </button>
      ) : null}

      <Dialog
        open={editorOpen}
        onOpenChange={(open) => flowStep === "details" && setEditorOpen(open)}
      >
        <DialogContent
          className="overflow-hidden p-0 sm:max-w-lg"
          showCloseButton={flowStep === "details"}
        >
          <div className="border-b bg-muted/25 px-6 py-5">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              <span
                className={cn(
                  "flex size-5 items-center justify-center border",
                  flowStep === "details" && "border-primary bg-primary text-primary-foreground",
                )}
              >
                1
              </span>
              <span className="h-px w-5 bg-border" />
              <span
                className={cn(
                  "flex size-5 items-center justify-center border",
                  flowStep !== "details" && "border-primary bg-primary text-primary-foreground",
                )}
              >
                2
              </span>
              <span className="ml-1">Configure · Authorize</span>
            </div>
            <DialogHeader className="mt-4">
              <DialogTitle className="text-xl">
                {editing ? "Edit MCP server" : "Connect an MCP server"}
              </DialogTitle>
              <DialogDescription>
                {flowStep === "details"
                  ? "Enter the remote endpoint. Discovery and authentication happen next."
                  : flowStep === "discovering"
                    ? "Checking the endpoint and discovering its OAuth configuration…"
                    : "Discovery complete. Opening the server’s secure sign-in page…"}
              </DialogDescription>
            </DialogHeader>
          </div>

          {flowStep === "details" ? (
            <div className="space-y-5 px-6 py-5">
              <div className="space-y-2">
                <Label htmlFor="mcp-name">Display name</Label>
                <Input
                  id="mcp-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Linear workspace"
                  maxLength={80}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  A recognizable label for your dashboard and chat tools.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-url">Server URL</Label>
                <Input
                  id="mcp-url"
                  type="url"
                  inputMode="url"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  maxLength={2048}
                />
                <p className="text-xs text-muted-foreground">
                  Public HTTPS only. Private networks, embedded credentials, and custom ports are
                  blocked.
                </p>
              </div>
              <div className="flex items-start gap-3 border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                OAuth tokens are encrypted before storage and are never returned to this browser.
              </div>
            </div>
          ) : (
            <div className="px-6 py-10">
              <div className="relative mx-auto flex size-16 items-center justify-center border border-primary/30 bg-primary/5 text-primary">
                <div className="absolute inset-0 animate-ping border border-primary/20 opacity-40 motion-reduce:animate-none" />
                {flowStep === "discovering" ? (
                  <LoaderCircle className="size-6 animate-spin motion-reduce:animate-none" />
                ) : (
                  <ArrowUpRight className="size-6" />
                )}
              </div>
              <p className="mt-5 text-center text-sm font-medium">
                {flowStep === "discovering"
                  ? "Discovering secure connection"
                  : "Continue with your MCP server"}
              </p>
              <p className="mx-auto mt-2 max-w-xs text-center text-xs leading-5 text-muted-foreground">
                This can take a few seconds. Keep this window open while we validate the server.
              </p>
            </div>
          )}

          <DialogFooter className="mx-0 mb-0 rounded-none px-6">
            {flowStep === "details" ? (
              <>
                <Button variant="outline" onClick={() => setEditorOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void saveConnection()}
                  disabled={!name.trim() || !serverUrl.trim()}
                >
                  <Plug /> {editing ? "Save changes" : "Discover & connect"}
                </Button>
              </>
            ) : (
              <p className="w-full text-center text-xs text-muted-foreground">
                Protected by PKCE and strict redirect validation
              </p>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!disconnecting} onOpenChange={(open) => !open && setDisconnecting(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {disconnecting?.name}?</DialogTitle>
            <DialogDescription>
              This removes the connection and its encrypted OAuth credentials. Chat sessions will no
              longer be able to use this server.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-3 border border-destructive/25 bg-destructive/5 p-3 text-xs text-muted-foreground">
            <Trash2 className="mt-0.5 size-4 shrink-0 text-destructive" />
            You can reconnect later, but you will need to authorize again.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnecting(undefined)}>
              Keep connected
            </Button>
            <Button
              variant="destructive"
              onClick={() => void disconnect()}
              disabled={pending?.action === "disconnect"}
            >
              {pending?.action === "disconnect" ? (
                <LoaderCircle className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Unplug />
              )}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
