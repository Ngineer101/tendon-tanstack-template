import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, PlugZap, ShieldCheck } from "lucide-react";

import { Button } from "#/components/ui/button";
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
import type { McpServerDto } from "#/lib/mcp/config";

import { McpApiError, useCreateServer, useMcpServers, useReconnectServer } from "./use-mcp-servers";

type Step = "details" | "authorizing" | "done";

interface ConnectServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog skips the form and immediately restarts authorization. */
  reconnectTarget?: McpServerDto | null;
}

function openAuthorizationPopup(url: string) {
  // NOTE: no `noopener` here — it would make window.open return null, which we
  // use to detect blocked popups (and to auto-close the window on success).
  // The opened page is the user's own MCP identity provider; cross-origin
  // opener access is heavily restricted by modern browsers.
  return window.open(url, "mcp-oauth", "width=640,height=760");
}

export function ConnectServerDialog({
  open,
  onOpenChange,
  reconnectTarget,
}: ConnectServerDialogProps) {
  const [step, setStep] = useState<Step>("details");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const [limitReached, setLimitReached] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string>();
  const [authorizingServerId, setAuthorizingServerId] = useState<string>();
  const [popupBlocked, setPopupBlocked] = useState(false);
  const popupRef = useRef<Window | null>(null);

  const createServer = useCreateServer();
  const reconnectServer = useReconnectServer();

  // Poll the server list while we wait for the OAuth redirect to complete.
  const serversQuery = useMcpServers({ polling: open && step === "authorizing" });
  const authorizingServer = serversQuery.data?.servers.find(
    (server) => server.id === authorizingServerId,
  );

  const busy = createServer.isPending || reconnectServer.isPending;

  // Reset local state whenever the dialog is opened for a new attempt.
  useEffect(() => {
    if (!open) return;
    setStep("details");
    setError(undefined);
    setLimitReached(false);
    setAuthorizationUrl(undefined);
    setAuthorizingServerId(undefined);
    setPopupBlocked(false);
    if (!reconnectTarget) {
      setName("");
      setUrl("");
    }
  }, [open, reconnectTarget]);

  // Kick off re-authorization as soon as the dialog opens in reconnect mode.
  useEffect(() => {
    if (!open || !reconnectTarget) return;
    startAuthorizationFor(reconnectTarget.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reconnectTarget?.id]);

  // Watch the polled server status while authorizing.
  useEffect(() => {
    if (step !== "authorizing" || !authorizingServer) return;
    if (authorizingServer.status === "connected") {
      popupRef.current?.close();
      setStep("done");
    } else if (authorizingServer.status === "reconnect_required") {
      popupRef.current?.close();
      setError(authorizingServer.lastError ?? "Authorization did not complete. Try again.");
      setStep("details");
      if (reconnectTarget) {
        setName(reconnectTarget.name);
        setUrl(reconnectTarget.url);
      }
    }
  }, [step, authorizingServer, reconnectTarget]);

  function handleAuthorizationResult(result: {
    server: McpServerDto;
    authorizationUrl: string | null;
  }) {
    if (result.authorizationUrl) {
      setAuthorizationUrl(result.authorizationUrl);
      setAuthorizingServerId(result.server.id);
      setStep("authorizing");
      const popup = openAuthorizationPopup(result.authorizationUrl);
      popupRef.current = popup;
      if (!popup) setPopupBlocked(true);
      return;
    }
    if (result.server.status === "connected") {
      setStep("done");
      return;
    }
    // Discovery or connectivity failed; the entry was kept so the user can
    // retry from the dashboard grid.
    setError(result.server.lastError ?? "Unable to reach the MCP server.");
  }

  function startAuthorizationFor(serverId: string) {
    setError(undefined);
    reconnectServer.mutate(serverId, {
      onSuccess: handleAuthorizationResult,
      onError: (reason) =>
        setError(reason instanceof Error ? reason.message : "Unable to restart authorization"),
    });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setLimitReached(false);
    createServer.mutate(
      { name, url },
      {
        onSuccess: handleAuthorizationResult,
        onError: (reason) => {
          if (reason instanceof McpApiError && reason.code === "limit_reached") {
            setLimitReached(true);
          }
          setError(reason instanceof Error ? reason.message : "Unable to connect the server");
        },
      },
    );
  }

  function handleOpenChange(next: boolean) {
    if (busy) return;
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        {step === "details" && (
          <form onSubmit={handleSubmit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>
                {reconnectTarget ? `Reconnect ${reconnectTarget.name}` : "Connect an MCP server"}
              </DialogTitle>
              <DialogDescription>
                {reconnectTarget
                  ? "Re-running discovery and authorization for this server."
                  : "Point Tendon at your server's MCP endpoint. We'll discover its OAuth configuration and verify the connection."}
              </DialogDescription>
            </DialogHeader>

            {reconnectTarget ? (
              busy ? (
                <div className="flex items-center gap-2 border px-3 py-2.5 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Contacting the server…
                </div>
              ) : (
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => startAuthorizationFor(reconnectTarget.id)}
                >
                  <PlugZap className="size-4" />
                  Restart authorization
                </Button>
              )
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-name">Name</Label>
                  <Input
                    id="mcp-name"
                    placeholder="Linear, GitHub, internal tools…"
                    autoComplete="off"
                    maxLength={80}
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-url">Server URL</Label>
                  <Input
                    id="mcp-url"
                    type="url"
                    inputMode="url"
                    placeholder="https://mcp.example.com/mcp"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    HTTPS only. Your credentials are encrypted before they are stored.
                  </p>
                </div>
              </>
            )}

            {error && (
              <div className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1">
                <p className="border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                  {error}
                </p>
                {limitReached && (
                  <a
                    href="/billing"
                    className="mt-1.5 inline-block text-xs text-primary underline-offset-4 hover:underline"
                  >
                    View upgrade options →
                  </a>
                )}
              </div>
            )}

            {!reconnectTarget && (
              <DialogFooter>
                <Button type="submit" disabled={busy} className="min-w-32">
                  {busy ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Discovering…
                    </>
                  ) : (
                    "Discover & connect"
                  )}
                </Button>
              </DialogFooter>
            )}
          </form>
        )}

        {step === "authorizing" && (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Authorize access</DialogTitle>
              <DialogDescription>
                Sign in with the MCP server's identity provider in the window we just opened. This
                page updates automatically when you're done.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-3 border px-3 py-3">
              <div className="relative flex size-9 items-center justify-center">
                <span className="absolute inline-flex size-full motion-safe:animate-ping motion-safe:opacity-20 border border-primary" />
                <ShieldCheck className="size-5 text-primary" />
              </div>
              <div className="min-w-0 text-sm">
                <p className="font-medium">Waiting for authorization…</p>
                <p className="truncate text-xs text-muted-foreground">
                  {authorizingServer?.name ?? reconnectTarget?.name ?? "MCP server"}
                </p>
              </div>
              <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" />
            </div>

            {popupBlocked && (
              <p className="border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400">
                The popup was blocked. Use the button below to open the authorization page.
              </p>
            )}

            {error && (
              <p className="border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive motion-safe:animate-in motion-safe:fade-in-0">
                {error}
              </p>
            )}

            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Finish later
              </Button>
              {authorizationUrl && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const popup = openAuthorizationPopup(authorizationUrl);
                    popupRef.current = popup;
                    setPopupBlocked(!popup);
                  }}
                >
                  <ExternalLink className="size-4" />
                  Open authorization page
                </Button>
              )}
            </DialogFooter>
          </div>
        )}

        {step === "done" && (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Server connected</DialogTitle>
              <DialogDescription>
                Credentials were encrypted and stored. The server is ready to use in your chat
                sessions.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-3 border border-primary/30 bg-primary/10 px-3 py-3">
              <span className="flex size-9 items-center justify-center border border-primary/40 bg-background text-primary motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-300">
                <Check className="size-5" />
              </span>
              <p className="text-sm font-medium">Connection verified</p>
            </div>

            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
