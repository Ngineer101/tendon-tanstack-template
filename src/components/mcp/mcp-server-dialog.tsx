import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Check, Loader2, RefreshCw, Sparkles } from "lucide-react";

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
import type { PublicMcpServer } from "#/lib/mcp/config";
import { authorizeServer, createServer, McpApiError, updateServer } from "./client";

type Phase =
  | { step: "form"; error?: string; limitReached?: boolean }
  | { step: "working"; stage: "save" | "probe" | "redirect" | "connected" }
  | { step: "connect_failed"; error: string; serverId: string };

interface McpServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: PublicMcpServer;
  onSaved: () => void | Promise<void>;
  onConnected: (serverId: string) => void;
}

const STAGE_ORDER = ["save", "probe", "redirect", "connected"] as const;

function ConnectSteps({ stage, editing }: { stage: string; editing: boolean }) {
  const stageIndex = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
  const steps = [
    { id: "save", label: editing ? "Saving changes" : "Saving server" },
    { id: "probe", label: "Checking server & discovering auth" },
    {
      id: "redirect",
      label: stage === "connected" ? "Connected" : "Handing off to authorization",
    },
  ];
  return (
    <ol className="flex flex-col gap-3 py-2">
      {steps.map((step, index) => {
        const done = stageIndex > index || stage === "connected";
        const active = !done && stageIndex === index;
        return (
          <li
            key={step.id}
            className={cn(
              "flex items-center gap-2.5 text-sm transition-colors duration-300",
              done ? "text-foreground" : active ? "text-foreground" : "text-muted-foreground/50",
            )}
          >
            <span className="flex size-5 shrink-0 items-center justify-center border">
              {done ? (
                <Check className="size-3 text-primary animate-in zoom-in-50 duration-200" />
              ) : active ? (
                <Loader2 className="size-3 animate-spin text-primary" />
              ) : (
                <span className="size-1 bg-muted-foreground/40" />
              )}
            </span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

export function McpServerDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
  onConnected,
}: McpServerDialogProps) {
  const [phase, setPhase] = useState<Phase>({ step: "form" });
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const redirecting = useRef(false);

  useEffect(() => {
    if (open) {
      setPhase({ step: "form" });
      setName(editing?.name ?? "");
      setUrl(editing?.url ?? "");
      redirecting.current = false;
    }
  }, [open, editing]);

  const busy = phase.step === "working";

  async function connect(serverId: string) {
    setPhase({ step: "working", stage: "probe" });
    try {
      const result = await authorizeServer(serverId);
      if (result.kind === "connected") {
        setPhase({ step: "working", stage: "connected" });
        await onSaved();
        setTimeout(() => {
          onOpenChange(false);
          onConnected(serverId);
        }, 1200);
        return;
      }
      setPhase({ step: "working", stage: "redirect" });
      redirecting.current = true;
      // A beat of feedback before leaving so the handoff doesn't feel abrupt.
      setTimeout(() => window.location.assign(result.authorizeUrl), 600);
    } catch (reason) {
      await onSaved();
      setPhase({
        step: "connect_failed",
        error: reason instanceof Error ? reason.message : "Unable to connect to the server",
        serverId,
      });
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPhase({ step: "working", stage: "save" });
    try {
      if (editing) {
        const { server } = await updateServer(editing.id, { name: name.trim(), url: url.trim() });
        await onSaved();
        if (server.status === "pending_auth") {
          // The URL changed, so previous credentials were reset — reconnect now.
          await connect(server.id);
        } else {
          onOpenChange(false);
        }
      } else {
        const { server } = await createServer({ name: name.trim(), url: url.trim() });
        await connect(server.id);
      }
    } catch (reason) {
      const limitReached = reason instanceof McpApiError && reason.code === "mcp_server_limit";
      setPhase({
        step: "form",
        error:
          reason instanceof Error ? reason.message : "Unable to save the server — please try again",
        limitReached,
      });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (busy || redirecting.current)) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit MCP server" : "Connect an MCP server"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the name or URL. Changing the URL requires reconnecting."
              : "Point to a remote MCP server. We'll detect whether it needs authorization and walk you through it."}
          </DialogDescription>
        </DialogHeader>

        {phase.step === "form" && (
          <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Linear, Sentry, my automation server"
                maxLength={60}
                required
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-url">Server URL</Label>
              <Input
                id="mcp-url"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://mcp.example.com/mcp"
                required
              />
              <p className="text-xs text-muted-foreground">
                Must be a public https endpoint that speaks MCP over streamable HTTP.
              </p>
            </div>

            {phase.error && !phase.limitReached && (
              <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs animate-in fade-in-0 slide-in-from-top-1 duration-200">
                {phase.error}
              </p>
            )}
            {phase.limitReached && (
              <div className="flex flex-col gap-2 border border-primary/30 bg-primary/10 px-3 py-2.5 animate-in fade-in-0 slide-in-from-top-1 duration-200">
                <p className="text-xs">
                  You've reached the free plan limit of 3 MCP servers. Upgrade to Pro for unlimited
                  servers.
                </p>
                <Button asChild size="sm" className="self-start">
                  <Link to="/billing" search={{ checkout: undefined }}>
                    <Sparkles className="size-3.5" />
                    Upgrade to Pro
                  </Link>
                </Button>
              </div>
            )}

            <DialogFooter showCloseButton>
              <Button type="submit" disabled={!name.trim() || !url.trim()}>
                <ArrowUpRight className="size-4" />
                {editing ? "Save changes" : "Connect"}
              </Button>
            </DialogFooter>
          </form>
        )}

        {phase.step === "working" && (
          <div className="flex flex-col gap-2">
            <ConnectSteps stage={phase.stage} editing={!!editing} />
            {phase.stage === "redirect" && (
              <p className="text-xs text-muted-foreground animate-in fade-in-0 duration-300">
                Taking you to the server's login page — you'll come straight back here.
              </p>
            )}
            {phase.stage === "connected" && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 animate-in fade-in-0 duration-300">
                No authorization needed — this server is ready to use.
              </p>
            )}
          </div>
        )}

        {phase.step === "connect_failed" && (
          <div className="flex flex-col gap-3">
            <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm animate-in fade-in-0 duration-200">
              {phase.error}
            </p>
            <p className="text-xs text-muted-foreground">
              The server was saved — you can retry now or reconnect later from its card.
            </p>
            <DialogFooter showCloseButton>
              <Button onClick={() => void connect(phase.serverId)}>
                <RefreshCw className="size-4" />
                Try again
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
