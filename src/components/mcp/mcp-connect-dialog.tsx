import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck } from "lucide-react";

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
import type { McpServerPublic } from "#/lib/mcp/config";

export type ConnectOutcome =
  | { kind: "connected"; server: McpServerPublic }
  | { kind: "authorize"; authorizationUrl: string; server: McpServerPublic }
  | { kind: "error"; message: string };

type Step = "form" | "authorize" | "success";

export function McpConnectDialog({
  open,
  onOpenChange,
  editing,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set the dialog edits this server, otherwise it connects a new one. */
  editing: McpServerPublic | null;
  onSubmit: (input: { url: string; name?: string }) => Promise<ConnectOutcome>;
}) {
  const [step, setStep] = useState<Step>("form");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [authResult, setAuthResult] = useState<{
    authorizationUrl: string;
    server: McpServerPublic;
  }>();
  const [connectedServer, setConnectedServer] = useState<McpServerPublic>();

  // Reset the flow whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setStep("form");
      setUrl(editing?.url ?? "");
      setName(editing?.name ?? "");
      setError(undefined);
      setPending(false);
      setAuthResult(undefined);
      setConnectedServer(undefined);
    }
  }, [open, editing]);

  // Briefly show the success state before closing; feels responsive without
  // making the user hunt for the close button.
  useEffect(() => {
    if (step !== "success") return;
    const timer = setTimeout(() => onOpenChange(false), 1800);
    return () => clearTimeout(timer);
  }, [step, onOpenChange]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(undefined);
    setPending(true);
    try {
      const outcome = await onSubmit({ url: url.trim(), name: name.trim() || undefined });
      if (outcome.kind === "connected") {
        setConnectedServer(outcome.server);
        setStep("success");
      } else if (outcome.kind === "authorize") {
        setAuthResult({ authorizationUrl: outcome.authorizationUrl, server: outcome.server });
        setStep("authorize");
      } else {
        setError(outcome.message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit MCP server" : "Connect an MCP server"}</DialogTitle>
          <DialogDescription>
            {step === "form" &&
              "Point the app at a streamable HTTP MCP endpoint. We will discover its authentication requirements automatically."}
            {step === "authorize" &&
              "This server uses OAuth. Authorize access to finish connecting."}
            {step === "success" && "The handshake completed successfully."}
          </DialogDescription>
        </DialogHeader>

        <div key={step} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
          {step === "form" && (
            <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-url">Server URL</Label>
                <Input
                  id="mcp-url"
                  type="url"
                  required
                  placeholder="https://mcp.example.com/mcp"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  aria-invalid={!!error}
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-name">
                  Display name <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="mcp-name"
                  placeholder="e.g. Linear, GitHub, internal tools"
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              {error && (
                <p
                  role="alert"
                  className="animate-in fade-in-0 slide-in-from-top-1 border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive duration-150"
                >
                  {error}
                </p>
              )}

              <DialogFooter>
                <Button type="submit" disabled={pending || !url.trim()}>
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  {pending ? "Discovering..." : editing ? "Save changes" : "Discover and connect"}
                </Button>
              </DialogFooter>
            </form>
          )}

          {step === "authorize" && authResult && (
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3 border border-primary/30 bg-primary/10 px-3 py-3">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                <p className="text-sm">
                  <span className="font-medium">{authResult.server.name}</span> asked for OAuth
                  authorization. You will be redirected to its authorization server and brought back
                  here afterwards.
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setStep("form")}>
                  Back
                </Button>
                <Button onClick={() => window.location.assign(authResult.authorizationUrl)}>
                  <ExternalLink className="size-4" />
                  Authorize access
                </Button>
              </DialogFooter>
            </div>
          )}

          {step === "success" && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="animate-in zoom-in-50 fade-in-0 duration-300">
                <CheckCircle2 className="size-10 text-emerald-500" />
              </span>
              <div>
                <p className="font-medium">{connectedServer?.name ?? "Server"} connected</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {connectedServer?.toolCount != null
                    ? `${connectedServer.toolCount} ${connectedServer.toolCount === 1 ? "tool" : "tools"} available for your chat sessions.`
                    : "Ready for your chat sessions."}
                </p>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
