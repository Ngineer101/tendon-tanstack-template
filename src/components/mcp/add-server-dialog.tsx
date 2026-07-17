import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CheckCircle2, Loader2, Lock, ShieldCheck } from "lucide-react";

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
import { cn } from "#/lib/utils";
import { apiRequest, type StartConnectionResponse } from "./mcp-api";

type WizardStep = "form" | "discovering" | "success" | "authorize" | "error";

const DISCOVERY_STEPS = [
  "Validating server URL",
  "Contacting MCP server",
  "Checking authorization",
] as const;

interface AddServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}

export function AddServerDialog({ open, onOpenChange, onConnected }: AddServerDialogProps) {
  const [step, setStep] = useState<WizardStep>("form");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [discoveryStepIndex, setDiscoveryStepIndex] = useState(0);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const timersRef = useRef<number[]>([]);

  function clearTimers() {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  }

  function reset() {
    clearTimers();
    setStep("form");
    setError(null);
    setAuthorizationUrl(null);
    setDiscoveryStepIndex(0);
  }

  useEffect(() => {
    if (!open) {
      // Let the close animation finish before resetting the wizard state.
      const timer = window.setTimeout(reset, 200);
      return () => window.clearTimeout(timer);
    }
  }, [open]);

  useEffect(() => clearTimers, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (step === "discovering") return;

    setError(null);
    setStep("discovering");
    setDiscoveryStepIndex(0);

    // Cosmetic step progression while the request is in flight — the final
    // state always comes from the server response.
    timersRef.current = DISCOVERY_STEPS.map((_, index) =>
      window.setTimeout(() => setDiscoveryStepIndex(index), 350 * index),
    );

    try {
      const result = await apiRequest<StartConnectionResponse>("/api/mcp/servers", {
        method: "POST",
        body: { name, url },
      });
      clearTimers();
      setDiscoveryStepIndex(DISCOVERY_STEPS.length - 1);

      if (result.type === "connected") {
        // Brief beat so the user sees the completed checklist before the
        // success state animates in.
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        setStep("success");
        onConnected();
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        setAuthorizationUrl(result.authorizationUrl);
        setStep("authorize");
      }
    } catch (reason) {
      clearTimers();
      setError(reason instanceof Error ? reason.message : "Could not connect to the server");
      setStep("error");
    }
  }

  function hostOf(rawUrl: string) {
    try {
      return new URL(rawUrl).host;
    } catch {
      return rawUrl;
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect an MCP server</DialogTitle>
          <DialogDescription>
            {step === "authorize"
              ? "This server uses OAuth. You'll be redirected to authorize access."
              : step === "success"
                ? "The server is connected and ready to use."
                : "Enter the server details. We'll discover its capabilities and authorization requirements."}
          </DialogDescription>
        </DialogHeader>

        {(step === "form" || step === "error") && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name">Display name</Label>
              <Input
                id="mcp-name"
                placeholder="e.g. Linear, GitHub, Internal tools"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-url">Server URL</Label>
              <Input
                id="mcp-url"
                type="url"
                inputMode="url"
                placeholder="https://mcp.example.com/mcp"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                HTTPS only. The URL is validated server-side against internal-network access.
              </p>
            </div>

            {step === "error" && error && (
              <p className="border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive animate-in fade-in-0 slide-in-from-top-1 duration-300">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="submit" className="w-full sm:w-auto">
                {step === "error" ? "Try again" : "Connect server"}
                <ArrowRight className="size-4" />
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === "discovering" && (
          <div className="flex flex-col gap-2 py-2" aria-live="polite">
            {DISCOVERY_STEPS.map((label, index) => {
              const state =
                index < discoveryStepIndex
                  ? "done"
                  : index === discoveryStepIndex
                    ? "active"
                    : "pending";
              return (
                <div
                  key={label}
                  className={cn(
                    "flex items-center gap-2.5 px-1 py-1.5 text-sm transition-opacity duration-300",
                    state === "pending" && "opacity-40",
                  )}
                >
                  <span className="flex size-5 items-center justify-center">
                    {state === "done" ? (
                      <Check className="size-4 text-emerald-500 animate-in zoom-in-50 duration-300" />
                    ) : state === "active" ? (
                      <Loader2 className="size-4 animate-spin text-primary" />
                    ) : (
                      <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                    )}
                  </span>
                  <span className={cn(state === "active" && "font-medium")}>{label}</span>
                </div>
              );
            })}
            <p className="mt-2 truncate px-1 font-mono text-xs text-muted-foreground">
              {hostOf(url)}
            </p>
          </div>
        )}

        {step === "authorize" && authorizationUrl && (
          <div className="flex flex-col gap-4 animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
            <div className="flex items-start gap-3 border border-primary/30 bg-primary/5 px-3.5 py-3">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="text-sm">
                <p className="font-medium">Authorization required</p>
                <p className="mt-1 text-muted-foreground">
                  <span className="font-mono text-foreground">{hostOf(url)}</span> asked us to
                  continue over OAuth. Your credentials are encrypted before they are stored and
                  never leave the server.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setStep("form");
                  setAuthorizationUrl(null);
                }}
              >
                Back
              </Button>
              <Button onClick={() => window.location.assign(authorizationUrl!)}>
                <Lock className="size-4" />
                Authorize with {hostOf(url)}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "success" && (
          <div className="flex flex-col items-center gap-3 py-4 text-center animate-in fade-in-0 duration-300">
            <span className="flex size-12 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 animate-in zoom-in-50 duration-500">
              <CheckCircle2 className="size-6 text-emerald-500" />
            </span>
            <div>
              <p className="font-medium">Server connected</p>
              <p className="mt-1 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{name}</span> is now available in your
                workspace.
              </p>
            </div>
            <DialogFooter className="sm:justify-center">
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
