import { FlaskConical, Loader2, Pencil, PlugZap, Server, Trash2 } from "lucide-react";

import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader } from "#/components/ui/card";
import type { McpServerDto } from "#/lib/mcp/config";
import { cn } from "#/lib/utils";

import { McpStatusBadge } from "./status-badge";

interface ServerCardProps {
  server: McpServerDto;
  index: number;
  pendingAction: "test" | null;
  onTest: (server: McpServerDto) => void;
  onReconnect: (server: McpServerDto) => void;
  onEdit: (server: McpServerDto) => void;
  onDisconnect: (server: McpServerDto) => void;
}

function formatRelativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function McpServerCard({
  server,
  index,
  pendingAction,
  onTest,
  onReconnect,
  onEdit,
  onDisconnect,
}: ServerCardProps) {
  const testing = pendingAction === "test";
  const needsAction = server.status === "pending_auth" || server.status === "reconnect_required";

  return (
    <Card
      className={cn(
        "group relative flex flex-col transition-all duration-200",
        "hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-sm",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2",
      )}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms`, animationFillMode: "backwards" }}
    >
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center border bg-muted text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
              <Server className="size-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight">{server.name}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{server.url}</p>
            </div>
          </div>
          <McpStatusBadge status={server.status} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-end gap-3">
        <div
          key={server.lastError ?? "ok"}
          className="motion-safe:animate-in motion-safe:fade-in-0"
        >
          {server.lastError ? (
            <p className="border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
              {server.lastError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {server.lastTestedAt
                ? `Last verified ${formatRelativeTime(server.lastTestedAt)}`
                : server.status === "connected"
                  ? "Ready to use in chat sessions"
                  : "Not verified yet"}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {needsAction ? (
            <Button
              size="sm"
              onClick={() => onReconnect(server)}
              className="motion-safe:animate-pulse"
            >
              <PlugZap className="size-3.5" />
              {server.status === "pending_auth" ? "Finish connecting" : "Reconnect"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onTest(server)}
              disabled={testing}
              className="min-w-[4.5rem]"
            >
              {testing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FlaskConical className="size-3.5" />
              )}
              {testing ? "Testing" : "Test"}
            </Button>
          )}

          <div className="ml-auto flex items-center">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => onEdit(server)}
              aria-label={`Edit ${server.name}`}
            >
              <Pencil />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => onDisconnect(server)}
              aria-label={`Disconnect ${server.name}`}
              className="hover:text-destructive"
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
