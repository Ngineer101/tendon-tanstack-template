import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  PlugZap,
  RefreshCw,
  Server,
  Unlink,
} from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { cn } from "#/lib/utils";
import type { McpServerDto } from "./mcp-api";

export type CardAction = "test" | "edit" | "reconnect" | "disconnect";

export interface CardFeedback {
  ok: boolean;
  message: string;
}

interface ServerCardProps {
  server: McpServerDto;
  pendingAction: CardAction | null;
  feedback: CardFeedback | null;
  style?: React.CSSProperties;
  onAction: (action: CardAction, server: McpServerDto) => void;
}

function StatusBadge({ status }: { status: McpServerDto["status"] }) {
  if (status === "connected") {
    return (
      <Badge className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
        </span>
        Connected
      </Badge>
    );
  }
  if (status === "requires_auth") {
    return (
      <Badge className="gap-1.5 border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400">
        <span className="size-1.5 rounded-full bg-amber-500" />
        Needs authorization
      </Badge>
    );
  }
  return (
    <Badge className="gap-1.5 border-destructive/30 bg-destructive/10 text-destructive">
      <span className="size-1.5 rounded-full bg-destructive" />
      Connection error
    </Badge>
  );
}

export function ServerCard({ server, pendingAction, feedback, style, onAction }: ServerCardProps) {
  const busy = pendingAction !== null;

  function hostOf(url: string) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  return (
    <Card
      style={style}
      className={cn(
        "group animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-500 transition-colors hover:border-foreground/20",
      )}
      data-server-id={server.id}
    >
      <CardHeader className="gap-3 p-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center border bg-muted/50 text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
              <Server className="size-4" />
            </div>
            <div className="min-w-0">
              <CardTitle className="truncate text-sm">{server.name}</CardTitle>
              <CardDescription className="truncate font-mono text-xs" title={server.url}>
                {hostOf(server.url)}
              </CardDescription>
            </div>
          </div>
          <StatusBadge status={server.status} />
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 p-5 pt-0">
        <div className="min-h-4 text-xs text-muted-foreground">
          {server.serverName ? (
            <span className="font-mono">
              {server.serverName}
              {server.serverVersion ? ` · v${server.serverVersion}` : ""}
            </span>
          ) : (
            <span className="font-mono opacity-60">No server metadata yet</span>
          )}
        </div>

        {server.lastError && server.status !== "connected" && (
          <p className="flex items-start gap-1.5 border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs text-destructive animate-in fade-in-0">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span className="break-words">{server.lastError}</span>
          </p>
        )}

        {feedback && (
          <p
            className={cn(
              "flex items-start gap-1.5 border px-2.5 py-2 text-xs animate-in fade-in-0 slide-in-from-top-1 duration-300",
              feedback.ok
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
          >
            {feedback.ok ? (
              <CheckCircle2 className="mt-0.5 size-3 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            )}
            <span>{feedback.message}</span>
          </p>
        )}

        <div className="mt-auto flex items-center gap-1.5 pt-1">
          {server.status === "requires_auth" ? (
            <Button
              size="sm"
              className="flex-1"
              disabled={busy}
              onClick={() => onAction("reconnect", server)}
            >
              {pendingAction === "reconnect" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Reconnect
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              disabled={busy}
              onClick={() => onAction("test", server)}
            >
              {pendingAction === "test" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <PlugZap className="size-3.5" />
              )}
              Test
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Edit ${server.name}`}
            onClick={() => onAction("edit", server)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            aria-label={`Disconnect ${server.name}`}
            onClick={() => onAction("disconnect", server)}
          >
            <Unlink className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export { type McpServerDto };
