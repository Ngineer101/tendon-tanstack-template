import { useState } from "react";
import { Activity, AlertTriangle, Pencil, Plug, RefreshCw, Trash2, Wrench } from "lucide-react";

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
import type { McpServerView } from "#/lib/mcp/config";
import { cn } from "#/lib/utils";

const STATUS_META: Record<
  McpServerView["status"],
  { label: string; dotClass: string; badgeClass: string }
> = {
  connected: {
    label: "Connected",
    dotClass: "bg-emerald-500",
    badgeClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  pending_auth: {
    label: "Needs authorization",
    dotClass: "bg-amber-500",
    badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  error: {
    label: "Error",
    dotClass: "bg-destructive",
    badgeClass: "border-destructive/30 bg-destructive/10 text-destructive",
  },
};

function relativeTime(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

interface ServerCardProps {
  server: McpServerView;
  index: number;
  busy?: "testing" | "authorizing" | "deleting";
  lastTest?: { ok: boolean; latencyMs?: number };
  onTest: () => void;
  onEdit: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
}

export function ServerCard({
  server,
  index,
  busy,
  lastTest,
  onTest,
  onEdit,
  onReconnect,
  onDisconnect,
}: ServerCardProps) {
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const status = STATUS_META[server.status];
  const hasConnectedBefore = server.lastConnectedAt !== null;

  return (
    <>
      <Card
        data-testid="mcp-server-card"
        className={cn(
          "group relative flex flex-col duration-300 animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-backwards",
          "transition-[transform,border-color,box-shadow] hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-sm",
          busy === "deleting" && "pointer-events-none scale-[0.98] opacity-40",
        )}
        style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
      >
        <CardHeader className="gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="relative flex size-2 shrink-0">
                {server.status === "connected" && (
                  <span
                    className={cn(
                      "absolute inline-flex size-full animate-ping opacity-60 [animation-duration:2.5s]",
                      status.dotClass,
                    )}
                  />
                )}
                <span className={cn("relative inline-flex size-2", status.dotClass)} />
              </span>
              <h3 className="truncate font-heading text-base font-medium">{server.name}</h3>
            </div>
            <div className="flex shrink-0 gap-0.5 opacity-100 transition-opacity duration-200 sm:opacity-40 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Test ${server.name}`}
                    disabled={!!busy}
                    onClick={onTest}
                  >
                    <Activity className={cn(busy === "testing" && "animate-pulse text-primary")} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Test connection</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${server.name}`}
                    disabled={!!busy}
                    onClick={onEdit}
                  >
                    <Pencil />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Disconnect ${server.name}`}
                    disabled={!!busy}
                    onClick={() => setConfirmingDisconnect(true)}
                  >
                    <Trash2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Disconnect</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={server.serverUrl}>
            {server.serverUrl.replace(/^https?:\/\//, "")}
          </p>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col gap-3 pb-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge className={status.badgeClass}>{status.label}</Badge>
            {server.authType === "oauth" && <Badge>OAuth</Badge>}
            {server.toolCount !== null && (
              <Badge className="gap-1">
                <Wrench className="size-3" />
                {server.toolCount} {server.toolCount === 1 ? "tool" : "tools"}
              </Badge>
            )}
            {lastTest?.ok && lastTest.latencyMs !== undefined && (
              <Badge
                key={lastTest.latencyMs}
                className="border-primary/30 bg-primary/10 text-primary duration-300 animate-in fade-in-0 zoom-in-90"
              >
                {lastTest.latencyMs}ms
              </Badge>
            )}
          </div>

          {server.serverName && (
            <p className="text-xs text-muted-foreground">
              {server.serverName}
              {server.serverVersion ? ` · v${server.serverVersion}` : ""}
            </p>
          )}

          {server.lastError && server.status !== "connected" && (
            <p className="flex items-start gap-1.5 border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs duration-200 animate-in fade-in-0 slide-in-from-top-1">
              <AlertTriangle className="mt-px size-3.5 shrink-0 text-destructive" />
              {server.lastError}
            </p>
          )}
        </CardContent>

        <div className="flex items-center justify-between gap-2 p-6 pt-0 text-xs text-muted-foreground">
          <span>
            {server.status === "connected" && server.lastConnectedAt
              ? `Connected ${relativeTime(server.lastConnectedAt)}`
              : server.lastCheckedAt
                ? `Checked ${relativeTime(server.lastCheckedAt)}`
                : ""}
          </span>
          {server.status !== "connected" && (
            <Button
              size="sm"
              variant={server.status === "pending_auth" ? "default" : "outline"}
              disabled={!!busy}
              onClick={server.status === "pending_auth" ? onReconnect : onTest}
            >
              {server.status === "pending_auth" ? (
                <>
                  <Plug className={cn(busy === "authorizing" && "animate-pulse")} />
                  {hasConnectedBefore ? "Reconnect" : "Connect"}
                </>
              ) : (
                <>
                  <RefreshCw className={cn(busy === "testing" && "animate-spin")} />
                  Retry
                </>
              )}
            </Button>
          )}
        </div>
      </Card>

      <Dialog open={confirmingDisconnect} onOpenChange={setConfirmingDisconnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {server.name}?</DialogTitle>
            <DialogDescription>
              Chat sessions will no longer be able to use this server. Its saved authorization is
              deleted permanently.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingDisconnect(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingDisconnect(false);
                onDisconnect();
              }}
            >
              <Trash2 />
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
