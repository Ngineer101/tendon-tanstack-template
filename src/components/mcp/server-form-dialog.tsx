import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Loader2, Plug } from "lucide-react";

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
import type { McpServerView } from "#/lib/mcp/config";
import { cn } from "#/lib/utils";
import { McpApiError, mcpApi } from "./api";

const CONNECT_STEPS = ["Validating server URL", "Contacting the server", "Checking authorization"];

type Phase =
  | { kind: "form" }
  | { kind: "connecting" }
  | { kind: "connected"; server: McpServerView }
  | { kind: "authorize"; server: McpServerView };

// Advances a fake progress cursor through the checklist while the real request
// is in flight; the outcome itself is always driven by the server response.
function useProgressCursor(active: boolean) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active) {
      setStep(0);
      return;
    }
    const timer = setInterval(
      () => setStep((current) => Math.min(current + 1, CONNECT_STEPS.length - 1)),
      1100,
    );
    return () => clearInterval(timer);
  }, [active]);
  return step;
}

interface ServerFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // When set, the dialog edits an existing server instead of creating one.
  editing?: McpServerView;
  onSaved: () => void;
}

export function ServerFormDialog({ open, onOpenChange, editing, onSaved }: ServerFormDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [error, setError] = useState<string>();
  const [redirecting, setRedirecting] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const progressStep = useProgressCursor(phase.kind === "connecting");

  useEffect(() => {
    if (open) {
      setPhase({ kind: "form" });
      setName(editing?.name ?? "");
      setServerUrl(editing?.serverUrl ?? "");
      setError(undefined);
      setRedirecting(false);
    }
    return () => clearTimeout(closeTimer.current);
  }, [open, editing]);

  const urlChanged = editing !== undefined && serverUrl.trim() !== editing.serverUrl;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);

    // Renaming without touching the URL skips the probe entirely.
    if (editing && !urlChanged) {
      if (name.trim() === editing.name) {
        onOpenChange(false);
        return;
      }
      setPhase({ kind: "connecting" });
      try {
        await mcpApi.update(editing.id, { name: name.trim() });
        onSaved();
        onOpenChange(false);
      } catch (reason) {
        setPhase({ kind: "form" });
        setError(reason instanceof Error ? reason.message : "Unable to save changes");
      }
      return;
    }

    setPhase({ kind: "connecting" });
    try {
      const result = editing
        ? await mcpApi.update(editing.id, { name: name.trim(), serverUrl: serverUrl.trim() })
        : await mcpApi.create({ name: name.trim(), serverUrl: serverUrl.trim() });
      onSaved();
      if (result.requiresAuth) {
        setPhase({ kind: "authorize", server: result.server });
      } else {
        setPhase({ kind: "connected", server: result.server });
        closeTimer.current = setTimeout(() => onOpenChange(false), 1400);
      }
    } catch (reason) {
      setPhase({ kind: "form" });
      if (reason instanceof McpApiError && reason.code === "server_limit_reached") {
        setError(reason.message);
      } else {
        setError(reason instanceof Error ? reason.message : "Unable to connect to the server");
      }
    }
  }

  async function startAuthorization(server: McpServerView) {
    setError(undefined);
    setRedirecting(true);
    try {
      const { authorizationUrl } = await mcpApi.authorize(server.id);
      window.location.assign(authorizationUrl);
    } catch (reason) {
      setRedirecting(false);
      setError(reason instanceof Error ? reason.message : "Unable to start authorization");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit MCP server" : "Connect an MCP server"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the name or URL of this server."
              : "Point at a Streamable HTTP MCP endpoint. If the server requires OAuth you will be sent there to approve access."}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="flex items-start gap-2 border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm duration-200 animate-in fade-in-0 slide-in-from-top-1">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            {error}
          </p>
        )}

        {(phase.kind === "form" || phase.kind === "connecting") && (
          <form onSubmit={(event) => void submit(event)} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Linear"
                maxLength={60}
                required
                disabled={phase.kind === "connecting"}
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mcp-url">Server URL</Label>
              <Input
                id="mcp-url"
                type="url"
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="https://mcp.example.com/mcp"
                required
                disabled={phase.kind === "connecting"}
                className="font-mono text-xs"
              />
              {urlChanged && (
                <p className="text-xs text-amber-600 duration-200 animate-in fade-in-0 dark:text-amber-400">
                  Changing the URL resets this server&apos;s authorization.
                </p>
              )}
            </div>

            {phase.kind === "connecting" && (editing === undefined || urlChanged) && (
              <ol className="grid gap-2 border bg-muted/40 px-3 py-2.5">
                {CONNECT_STEPS.map((label, index) => (
                  <li
                    key={label}
                    className={cn(
                      "flex items-center gap-2 text-xs duration-300 animate-in fade-in-0 slide-in-from-left-2 fill-mode-backwards",
                      index > progressStep && "opacity-40",
                    )}
                    style={{ animationDelay: `${index * 80}ms` }}
                  >
                    {index < progressStep ? (
                      <Check className="size-3.5 text-primary duration-200 animate-in zoom-in-50" />
                    ) : index === progressStep ? (
                      <Loader2 className="size-3.5 animate-spin text-primary" />
                    ) : (
                      <span className="ml-1 size-1.5 bg-border" />
                    )}
                    {label}
                  </li>
                ))}
              </ol>
            )}

            <DialogFooter className="mt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={phase.kind === "connecting"}>
                {phase.kind === "connecting" ? (
                  <>
                    <Loader2 className="animate-spin" />
                    {editing ? "Saving..." : "Connecting..."}
                  </>
                ) : (
                  <>
                    <Plug />
                    {editing ? "Save changes" : "Connect"}
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        )}

        {phase.kind === "connected" && (
          <div className="flex flex-col items-center gap-3 py-6 text-center duration-300 animate-in fade-in-0 zoom-in-95">
            <CheckCircle2 className="size-10 text-emerald-500 duration-500 animate-in zoom-in-50" />
            <div>
              <p className="font-medium">{phase.server.name} is connected</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {phase.server.toolCount !== null
                  ? `${phase.server.toolCount} tools available in your chat sessions.`
                  : "Ready to use in your chat sessions."}
              </p>
            </div>
          </div>
        )}

        {phase.kind === "authorize" && (
          <div className="grid gap-4 duration-300 animate-in fade-in-0 slide-in-from-right-2">
            <div className="flex items-start gap-3 border bg-muted/40 px-3 py-3">
              <Plug className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="text-sm">
                <p className="font-medium">Authorization required</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {new URL(phase.server.serverUrl).hostname} uses OAuth. You&apos;ll be redirected
                  to approve access, then brought back here.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Later
              </Button>
              <Button onClick={() => void startAuthorization(phase.server)} disabled={redirecting}>
                {redirecting ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                {redirecting ? "Redirecting..." : "Continue to authorize"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
