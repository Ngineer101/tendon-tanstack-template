import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, KeyRound, Loader2, Pencil, Server, Trash2 } from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "#/components/ui/card";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip";
import type { McpServerStatus, McpServerSummary } from "#/lib/mcp/config";
import { cn } from "#/lib/utils";
import { MCP_SERVERS_QUERY_KEY, McpApiError, mcpApi } from "./api";

const STATUS_CONFIG: Record<
  McpServerStatus,
  { label: string; dotClass: string; badgeClass: string }
> = {
  connected: {
    label: "Connected",
    dotClass: "bg-emerald-500",
    badgeClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  needs_auth: {
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

export function formatRelativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

interface McpServerCardProps {
  server: McpServerSummary;
  index: number;
  onError: (message: string) => void;
}

export function McpServerCard({ server, index, onError }: McpServerCardProps) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [justTested, setJustTested] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY });

  const testMutation = useMutation({
    mutationFn: () => mcpApi.testConnection(server.id),
    onSuccess: async (result) => {
      await invalidate();
      if (result.server.status === "connected") {
        setJustTested(true);
        setTimeout(() => setJustTested(false), 2_000);
      }
    },
    onError: (error) => onError(error.message),
  });

  const reconnectMutation = useMutation({
    mutationFn: () => mcpApi.reconnect(server.id),
    onSuccess: async (result) => {
      if (result.authorizationUrl) {
        window.location.assign(result.authorizationUrl);
        return;
      }
      await invalidate();
    },
    onError: async (error) => {
      onError(error.message);
      await invalidate();
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => mcpApi.disconnect(server.id),
    onSuccess: async () => {
      setConfirmDisconnect(false);
      await invalidate();
    },
    onError: (error) => onError(error.message),
  });

  const status = STATUS_CONFIG[server.status];
  const testing = testMutation.isPending;
  const busy = testing || reconnectMutation.isPending || disconnectMutation.isPending;
  const lastSeen = formatRelativeTime(server.lastConnectedAt);

  return (
    <>
      <Card
        data-testid="mcp-server-card"
        className="group animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both gap-3 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[4px_4px_0_0_var(--color-border)]"
        style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
      >
        <CardHeader className="gap-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="relative flex size-2 shrink-0">
                {(server.status === "connected" || testing) && (
                  <span
                    className={cn(
                      "absolute inline-flex size-full animate-ping opacity-60 duration-1000",
                      testing ? "bg-primary" : status.dotClass,
                      !testing && "[animation-iteration-count:3]",
                    )}
                  />
                )}
                <span
                  className={cn(
                    "relative inline-flex size-2 transition-colors",
                    testing ? "bg-primary" : status.dotClass,
                  )}
                />
              </span>
              <span className="truncate font-heading text-base font-medium">{server.name}</span>
            </div>
            <Badge
              className={cn(
                "shrink-0 transition-colors duration-300",
                justTested
                  ? "animate-in zoom-in-95 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : status.badgeClass,
              )}
            >
              {testing ? "Testing..." : justTested ? "Healthy" : status.label}
            </Badge>
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={server.serverUrl}>
            {server.serverUrl}
          </p>
        </CardHeader>

        <CardContent className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Server className="size-3" />
            {server.serverInfo?.name ? (
              <span className="truncate">
                {server.serverInfo.name}
                {server.serverInfo.version ? ` v${server.serverInfo.version}` : ""}
              </span>
            ) : (
              <span>{server.authType === "oauth" ? "OAuth secured" : "No authentication"}</span>
            )}
            {server.serverInfo?.name && server.authType === "oauth" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <KeyRound className="size-3 text-primary" />
                </TooltipTrigger>
                <TooltipContent>Secured with OAuth</TooltipContent>
              </Tooltip>
            )}
          </div>
          {lastSeen && <p>Last connected {lastSeen}</p>}
          {server.status === "error" && server.lastError && (
            <p
              className="flex animate-in items-start gap-1.5 fade-in-0 slide-in-from-top-1 text-destructive"
              title={server.lastError}
            >
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span className="line-clamp-2">{server.lastError}</span>
            </p>
          )}
          {server.status === "needs_auth" && (
            <p className="text-amber-600 dark:text-amber-400">
              {server.lastError ?? "Finish authorizing to start using this server."}
            </p>
          )}
        </CardContent>

        <CardFooter className="gap-1.5">
          {server.status === "needs_auth" || server.status === "error" ? (
            <Button
              size="sm"
              onClick={() => reconnectMutation.mutate()}
              disabled={busy}
              data-testid="reconnect-button"
            >
              {reconnectMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <KeyRound className="size-3.5" />
              )}
              Reconnect
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={busy}
            >
              {testing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Activity className="size-3.5" />
              )}
              Test
            </Button>
          )}
          {(server.status === "needs_auth" || server.status === "error") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={busy}
            >
              {testing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Activity className="size-3.5" />
              )}
              Test
            </Button>
          )}
          <div className="ml-auto flex gap-1 opacity-100 transition-opacity duration-200 sm:opacity-60 sm:group-hover:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setEditOpen(true)}
                  disabled={busy}
                  aria-label={`Edit ${server.name}`}
                >
                  <Pencil className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={busy}
                  aria-label={`Disconnect ${server.name}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Disconnect</TooltipContent>
            </Tooltip>
          </div>
        </CardFooter>
      </Card>

      <EditServerDialog server={server} open={editOpen} onOpenChange={setEditOpen} />

      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {server.name}?</DialogTitle>
            <DialogDescription>
              This removes the server and permanently deletes its stored credentials. Your chat
              sessions will no longer be able to use it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDisconnect(false)}>
              Keep server
            </Button>
            <Button
              variant="destructive"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              data-testid="confirm-disconnect"
            >
              {disconnectMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function EditServerDialog({
  server,
  open,
  onOpenChange,
}: {
  server: McpServerSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(server.name);
  const [serverUrl, setServerUrl] = useState(server.serverUrl);
  const [error, setError] = useState<string>();

  const urlChanged = serverUrl.trim() !== server.serverUrl;

  const updateMutation = useMutation({
    mutationFn: () =>
      mcpApi.update(server.id, {
        ...(name.trim() !== server.name ? { name: name.trim() } : {}),
        ...(urlChanged ? { serverUrl: serverUrl.trim() } : {}),
      }),
    onSuccess: async (result) => {
      if (result.authorizationUrl) {
        window.location.assign(result.authorizationUrl);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY });
      onOpenChange(false);
    },
    onError: (mutationError) => {
      setError(
        mutationError instanceof McpApiError
          ? mutationError.message
          : "Unable to update the server",
      );
    },
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      setName(server.name);
      setServerUrl(server.serverUrl);
      setError(undefined);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit MCP server</DialogTitle>
          <DialogDescription>
            Changing the URL discards stored credentials and re-runs the connection flow.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(undefined);
            updateMutation.mutate();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={`edit-name-${server.id}`}>Name</Label>
            <Input
              id={`edit-name-${server.id}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`edit-url-${server.id}`}>Server URL</Label>
            <Input
              id={`edit-url-${server.id}`}
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              type="url"
              className="font-mono text-xs"
              required
            />
            {urlChanged && (
              <p className="animate-in fade-in-0 slide-in-from-top-1 text-xs text-amber-600 dark:text-amber-400">
                You may be asked to authorize the new server.
              </p>
            )}
          </div>
          {error && (
            <p className="animate-in fade-in-0 slide-in-from-top-1 border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="mt-1">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
