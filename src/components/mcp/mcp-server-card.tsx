import { Loader2, Pencil, PlugZap, RefreshCw, Server, Trash2, Wrench } from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import type { McpServerPublic } from "#/lib/mcp/config";
import { cn } from "#/lib/utils";

const STATUS_META: Record<
  McpServerPublic["status"],
  { label: string; dotClass: string; badgeClass: string; pulse: boolean }
> = {
  connected: {
    label: "Connected",
    dotClass: "bg-emerald-500",
    badgeClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    pulse: false,
  },
  pending_auth: {
    label: "Needs authorization",
    dotClass: "bg-amber-500",
    badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    pulse: true,
  },
  auth_expired: {
    label: "Authorization expired",
    dotClass: "bg-amber-500",
    badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    pulse: false,
  },
  error: {
    label: "Connection error",
    dotClass: "bg-destructive",
    badgeClass: "border-destructive/30 bg-destructive/10 text-destructive",
    pulse: false,
  },
};

function StatusBadge({ status }: { status: McpServerPublic["status"] }) {
  const meta = STATUS_META[status];
  return (
    <Badge className={cn("gap-1.5 transition-colors", meta.badgeClass)}>
      <span className="relative flex size-1.5">
        {meta.pulse && (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping",
              meta.dotClass,
              "opacity-60",
            )}
            style={{ borderRadius: "9999px" }}
          />
        )}
        <span
          className={cn("relative inline-flex size-1.5", meta.dotClass)}
          style={{ borderRadius: "9999px" }}
        />
      </span>
      {meta.label}
    </Badge>
  );
}

export interface ServerCardAction {
  kind: "test" | "reconnect" | "edit" | "disconnect";
  server: McpServerPublic;
}

export function McpServerCard({
  server,
  pendingAction,
  onAction,
  style,
}: {
  server: McpServerPublic;
  pendingAction: string | null;
  onAction: (action: ServerCardAction) => void;
  style?: React.CSSProperties;
}) {
  const pending = pendingAction !== null;
  const isPending = (kind: string) => pendingAction === kind;
  const needsReconnect = server.status === "pending_auth" || server.status === "auth_expired";
  const host = (() => {
    try {
      return new URL(server.url).host;
    } catch {
      return server.url;
    }
  })();

  return (
    <Card
      className={cn(
        "group animate-in fade-in-0 slide-in-from-bottom-2 transition-colors fill-mode-backwards hover:border-foreground/20",
        pendingAction === "test" && "border-primary/40",
      )}
      style={style}
      data-testid="mcp-server-card"
    >
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center border bg-muted text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
              <Server className="size-4" />
            </div>
            <div className="min-w-0">
              <CardTitle className="truncate text-base">{server.name}</CardTitle>
              <CardDescription className="truncate font-mono text-xs" title={server.url}>
                {host}
              </CardDescription>
            </div>
          </div>
          <StatusBadge status={server.status} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex min-h-5 items-center gap-3 text-xs text-muted-foreground">
          {server.status === "connected" ? (
            <>
              {server.serverName && (
                <span className="truncate">
                  {server.serverName}
                  {server.serverVersion ? ` v${server.serverVersion}` : ""}
                </span>
              )}
              {server.toolCount !== null && (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <Wrench className="size-3" />
                  {server.toolCount} {server.toolCount === 1 ? "tool" : "tools"}
                </span>
              )}
            </>
          ) : (
            <span className="truncate">
              {server.lastError ?? "Finish setup to use this server"}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {needsReconnect ? (
            <Button
              size="sm"
              onClick={() => onAction({ kind: "reconnect", server })}
              disabled={pending}
              className="transition-transform"
            >
              {isPending("reconnect") ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <PlugZap className="size-3.5" />
              )}
              {server.status === "pending_auth" ? "Finish setup" : "Reconnect"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onAction({ kind: "test", server })}
              disabled={pending}
            >
              {isPending("test") ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Test
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onAction({ kind: "edit", server })}
            disabled={pending}
          >
            <Pencil className="size-3.5" />
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onAction({ kind: "disconnect", server })}
            disabled={pending}
            className="text-muted-foreground hover:text-destructive"
          >
            {isPending("disconnect") ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            Disconnect
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
