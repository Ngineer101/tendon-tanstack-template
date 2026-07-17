import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Loader2, Search, ShieldCheck } from "lucide-react";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { fetchJson } from "#/lib/mcp/client";
import type { ConnectResult, DiscoverResult } from "#/lib/mcp/types";
import { cn } from "#/lib/utils";

interface ConnectMcpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (outcome: ConnectOutcome) => unknown;
}

export type ConnectOutcome = { kind: "redirected" } | { kind: "created"; serverId: string };

type Step = "form" | "discovering" | "review" | "connecting" | "error";

export function ConnectMcpDialog({ open, onOpenChange, onConnected }: ConnectMcpDialogProps) {
  const [step, setStep] = useState<Step>("form");
  const [serverUrl, setServerUrl] = useState("");
  const [name, setName] = useState("");
  const [discovered, setDiscovered] = useState<DiscoverResult>();
  const [error, setError] = useState<string>();

  // Reset to the initial step every time the dialog opens so a previous
  // attempt never leaves stale state.
  useEffect(() => {
    if (open) {
      setStep("form");
      setDiscovered(undefined);
      setError(undefined);
    }
  }, [open]);

  async function handleDiscover(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setStep("discovering");
    try {
      const result = await fetchJson<DiscoverResult>("/api/mcp/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "discover", serverUrl, name: name || undefined }),
      });
      setDiscovered(result);
      setServerUrl(result.serverUrl);
      if (result.name && !name) setName(result.name);
      setStep("review");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to discover OAuth metadata");
      setStep("error");
    }
  }

  async function handleConnect() {
    if (!discovered) return;
    setStep("connecting");
    try {
      const result = await fetchJson<ConnectResult>("/api/mcp/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "connect", serverUrl, name: name || undefined }),
      });
      await onConnected({ kind: "redirected" });
      onOpenChange(false);
      // Hand control to the MCP server. The dialog closes and the user is
      // redirected away to authorize; they come back through the callback.
      window.location.assign(result.authorizationUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to start the OAuth flow");
      setStep("error");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect MCP server</DialogTitle>
          <DialogDescription>
            Enter the root URL of your MCP server. We discover its OAuth metadata and start a secure
            authorization flow. Tokens are encrypted at rest.
          </DialogDescription>
        </DialogHeader>

        {/* Keyed remount per step so the micro-animation reruns. */}
        <StepStepTransition step={step}>
          {(step === "form" || step === "discovering" || step === "error") && (
            <form className="grid gap-3" onSubmit={handleDiscover}>
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-server-url">Server URL</Label>
                <Input
                  id="mcp-server-url"
                  type="url"
                  autoComplete="off"
                  placeholder="https://mcp.example.com"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  required
                  disabled={step === "discovering"}
                  autoFocus
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-server-name">Display name (optional)</Label>
                <Input
                  id="mcp-server-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  disabled={step === "discovering"}
                  placeholder="My MCP server"
                />
              </div>

              {error && (
                <p className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200 border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </p>
              )}

              <DialogFooter className="mt-2">
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={step === "discovering" || !serverUrl.trim()}>
                  {step === "discovering" ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      Discovering…
                    </>
                  ) : (
                    <>
                      <Search className="size-3.5" />
                      Discover
                    </>
                  )}
                </Button>
              </DialogFooter>
            </form>
          )}

          {(step === "review" || step === "connecting") && discovered && (
            <div className="grid gap-3">
              <div className="grid grid-cols-[auto_1fr] items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
                <ShieldCheck className="size-4 text-primary" />
                <span>
                  OAuth metadata discovered for <strong>{discovered.name}</strong>.
                </span>
              </div>
              <dl className="grid gap-2 text-sm">
                <Detail label="Server URL" value={discovered.serverUrl} />
                {discovered.authorizationEndpoint && (
                  <Detail label="Authorization" value={discovered.authorizationEndpoint} />
                )}
                {discovered.tokenEndpoint && (
                  <Detail label="Token" value={discovered.tokenEndpoint} />
                )}
                <Detail
                  label="Dynamic client registration"
                  value={discovered.supportsDynamicRegistration ? "Supported" : "Not supported"}
                />
              </dl>
              <p className="text-xs text-muted-foreground">
                You will be redirected to your MCP server to authorize. After you approve, you will
                return here with the connection saved.
              </p>
              <DialogFooter className="mt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep("form")}
                  disabled={step === "connecting"}
                >
                  Back
                </Button>
                <Button type="button" onClick={handleConnect} disabled={step === "connecting"}>
                  {step === "connecting" ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      Starting…
                    </>
                  ) : (
                    <>
                      Authorize
                      <ArrowRight className="size-3.5" />
                    </>
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}

          {/* Screen-reader hint while the redirect is in-flight. */}
          {step === "connecting" && (
            <p className="sr-only" aria-live="polite">
              Redirecting to your MCP server… If nothing happens, click Authorize again.
            </p>
          )}
        </StepStepTransition>

        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3" />
          Credentials never touch the browser.
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono" title={value}>
        {value}
      </dd>
    </div>
  );
}

// Wraps the step content and re-keys on step so the fade/slide micro-animation
// plays each time the user advances through the connect flow.
function StepStepTransition({ step, children }: { step: Step; children: React.ReactNode }) {
  return (
    <div
      key={step}
      className={cn(
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-300",
        step === "connecting" && "slide-in-from-bottom-0",
      )}
    >
      {children}
    </div>
  );
}
