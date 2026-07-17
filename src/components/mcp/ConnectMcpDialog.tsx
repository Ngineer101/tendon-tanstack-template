import { useEffect, useState } from "react";
import {
  IconLoader2,
  IconPlugConnected,
  IconServerBolt,
  IconShieldCheck,
} from "@tabler/icons-react";

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
import type { McpConnectResponse, ApiErrorBody } from "./types";

type Phase = "form" | "discovering" | "redirecting" | "error";

interface ConnectMcpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}

export function ConnectMcpDialog({ open, onOpenChange, onConnected }: ConnectMcpDialogProps) {
  const [phase, setPhase] = useState<Phase>("form");
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [error, setError] = useState<string>();
  const [discoveryHint, setDiscoveryHint] = useState<string>();

  // Reset state whenever the dialog is reopened.
  useEffect(() => {
    if (!open) {
      const reset = window.setTimeout(() => {
        setPhase("form");
        setName("");
        setServerUrl("");
        setError(undefined);
        setDiscoveryHint(undefined);
      }, 150);
      return () => window.clearTimeout(reset);
    }
  }, [open]);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !serverUrl.trim()) {
      setError("Enter a name and a server URL.");
      return;
    }
    setError(undefined);
    setPhase("discovering");
    setDiscoveryHint("Discovering OAuth endpoints…");
    try {
      const response = await fetch("/api/mcp/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), serverUrl: serverUrl.trim() }),
      });
      const body = (await response.json().catch(() => ({}))) as McpConnectResponse & ApiErrorBody;
      if (!response.ok || !body.authorizationUrl) {
        if (response.status === 402 && typeof body.limit === "number") {
          setError(
            `Free plans can connect at most ${body.limit} MCP servers. Upgrade to Pro for unlimited connections.`,
          );
        } else {
          setError(body.error ?? "Unable to connect to this MCP server.");
        }
        setPhase("error");
        return;
      }
      setDiscoveryHint("Redirecting to the MCP server to authorize…");
      setPhase("redirecting");
      onConnected();
      // Hand control to the MCP authorization server.
      window.location.assign(body.authorizationUrl);
    } catch {
      setError("Network error while connecting to the MCP server.");
      setPhase("error");
    }
  }

  const busy = phase === "discovering" || phase === "redirecting";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="inline-flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <IconPlugConnected className="size-4" />
            </span>
            Connect an MCP server
          </DialogTitle>
          <DialogDescription>
            Enter your server URL. We discover its OAuth endpoints and walk you through
            authorization.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleConnect} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              placeholder="e.g. Personal tools"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              autoComplete="off"
              maxLength={80}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mcp-url">Server URL</Label>
            <Input
              id="mcp-url"
              type="url"
              placeholder="https://mcp.example.com"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Must use <code className="font-mono">https</code> and be publicly reachable.
            </p>
          </div>

          {error && (
            <p
              role="alert"
              className="animate-in fade-in-0 slide-in-from-top-1 duration-200 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          {phase === "discovering" && (
            <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300 flex items-center gap-2 text-xs text-muted-foreground">
              <IconLoader2 className="size-3.5 animate-spin" />
              <span>{discoveryHint}</span>
            </div>
          )}
          {phase === "redirecting" && (
            <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300 flex items-center gap-2 text-xs text-muted-foreground">
              <IconShieldCheck className="size-3.5 text-primary" />
              <span>Opening your MCP server…</span>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {phase === "discovering" ? (
                <>
                  <IconLoader2 className="size-4 animate-spin" />
                  Discovering
                </>
              ) : phase === "redirecting" ? (
                <>
                  <IconServerBolt className="size-4" />
                  Redirecting
                </>
              ) : (
                <>
                  <IconPlugConnected className="size-4" />
                  Connect
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
