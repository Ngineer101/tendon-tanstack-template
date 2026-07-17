import { useState } from "react";
import { Check, Loader2, Pencil, Plug, RefreshCw, Trash2, Unplug, X, Zap } from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader } from "#/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";
import type { PublicMcpServer } from "#/lib/mcp/config";
import { formatRelativeTime, MCP_STATUS_CONFIG } from "./status";

type CardAction = "connect" | "test" | "disconnect" | "remove";

interface McpServerCardProps {
  server: PublicMcpServer;
  index: number;
  highlighted: boolean;
  onConnect: (server: PublicMcpServer) => Promise<void>;
  onTest: (server: PublicMcpServer) => Promise<boolean>;
  onDisconnect: (server: PublicMcpServer) => Promise<void>;
  onRemove: (server: PublicMcpServer) => Promise<void>;
  onEdit: (server: PublicMcpServer) => void;
}

function ActionIconButton({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn(
            "text-muted-foreground hover:text-foreground",
            destructive && "hover:bg-destructive/10 hover:text-destructive",
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function McpServerCard({
  server,
  index,
  highlighted,
  onConnect,
  onTest,
  onDisconnect,
  onRemove,
  onEdit,
}: McpServerCardProps) {
  const [pending, setPending] = useState<CardAction>();
  const [testFlash, setTestFlash] = useState<"ok" | "fail">();
  const [actionError, setActionError] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const status = MCP_STATUS_CONFIG[server.status];
  const host = (() => {
    try {
      return new URL(server.url).host;
    } catch {
      return server.url;
    }
  })();
  const capabilities = server.serverInfo?.capabilities;
  const capabilityLabels = [
    capabilities?.tools && "Tools",
    capabilities?.resources && "Resources",
    capabilities?.prompts && "Prompts",
  ].filter((label): label is string => Boolean(label));
  const checkedAt = formatRelativeTime(server.lastTestedAt);

  async function run(action: CardAction, task: () => Promise<void>) {
    setPending(action);
    setActionError(undefined);
    try {
      await task();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Something went wrong");
    } finally {
      setPending(undefined);
    }
  }

  async function handleTest() {
    await run("test", async () => {
      const healthy = await onTest(server);
      setTestFlash(healthy ? "ok" : "fail");
      setTimeout(() => setTestFlash(undefined), 1800);
    });
  }

  return (
    <Card
      className={cn(
        "group flex flex-col fill-mode-backwards animate-in fade-in-0 slide-in-from-bottom-2 duration-300 transition-[translate,border-color,box-shadow] hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
        highlighted && "border-primary ring-2 ring-primary/40",
      )}
      style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
    >
      <CardHeader className="p-4 pb-0">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="relative flex size-2 shrink-0">
              {status.pulse && (
                <span
                  className={cn(
                    "absolute inline-flex size-full animate-ping opacity-60 motion-reduce:hidden",
                    status.dotClass,
                  )}
                />
              )}
              <span className={cn("relative inline-flex size-2", status.dotClass)} />
            </span>
            <span className="truncate font-heading text-sm font-semibold">{server.name}</span>
          </span>
          <span className={cn("shrink-0 text-xs font-medium", status.textClass)}>
            {status.label}
          </span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground" title={server.url}>
          {host}
        </p>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        {server.serverInfo?.name ? (
          <p className="text-xs text-muted-foreground">
            {server.serverInfo.title ?? server.serverInfo.name}
            {server.serverInfo.version && (
              <span className="text-muted-foreground/60"> · v{server.serverInfo.version}</span>
            )}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/60 italic">
            {server.status === "pending_auth"
              ? "Connect to discover this server's capabilities."
              : "No server details yet."}
          </p>
        )}
        {capabilityLabels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {capabilityLabels.map((label) => (
              <Badge key={label} className="animate-in fade-in-0 zoom-in-95 duration-200">
                {label}
              </Badge>
            ))}
          </div>
        )}
        {(server.status === "error" || server.status === "needs_auth") && server.lastError && (
          <p className="line-clamp-2 text-xs text-destructive animate-in fade-in-0 duration-200">
            {server.lastError}
          </p>
        )}
        {actionError && (
          <p className="line-clamp-2 border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs animate-in fade-in-0 slide-in-from-top-1 duration-200">
            {actionError}
          </p>
        )}
        {checkedAt && (
          <p className="mt-auto text-[11px] text-muted-foreground/60">Checked {checkedAt}</p>
        )}
      </CardContent>

      <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          {server.status !== "connected" && (
            <Button
              size="sm"
              onClick={() => void run("connect", () => onConnect(server))}
              disabled={!!pending}
            >
              {pending === "connect" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : server.status === "pending_auth" ? (
                <Plug className="size-3.5" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {server.status === "pending_auth" ? "Connect" : "Reconnect"}
            </Button>
          )}
          {server.status !== "pending_auth" && server.status !== "disconnected" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleTest()}
              disabled={!!pending}
            >
              {pending === "test" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : testFlash === "ok" ? (
                <Check className="size-3.5 text-emerald-500 animate-in zoom-in-50 duration-200" />
              ) : testFlash === "fail" ? (
                <X className="size-3.5 text-destructive animate-in zoom-in-50 duration-200" />
              ) : (
                <Zap className="size-3.5" />
              )}
              Test
            </Button>
          )}
        </div>
        <div className="flex items-center">
          <ActionIconButton label="Edit" onClick={() => onEdit(server)} disabled={!!pending}>
            <Pencil />
          </ActionIconButton>
          {(server.status === "connected" || server.status === "needs_auth") && (
            <ActionIconButton
              label="Disconnect"
              onClick={() => void run("disconnect", () => onDisconnect(server))}
              disabled={!!pending}
            >
              {pending === "disconnect" ? <Loader2 className="animate-spin" /> : <Unplug />}
            </ActionIconButton>
          )}
          <ActionIconButton
            label="Remove"
            destructive
            onClick={() => setConfirmRemove(true)}
            disabled={!!pending}
          >
            <Trash2 />
          </ActionIconButton>
        </div>
      </div>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {server.name}?</DialogTitle>
            <DialogDescription>
              This deletes the connection and its stored credentials. Your chat sessions will no
              longer be able to use this server.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              variant="destructive"
              disabled={pending === "remove"}
              onClick={() =>
                void run("remove", async () => {
                  await onRemove(server);
                  setConfirmRemove(false);
                })
              }
            >
              {pending === "remove" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Remove server
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
