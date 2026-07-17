import { useEffect, useState } from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconEdit,
  IconLoader2,
  IconPlugConnectedX,
  IconRefresh,
  IconStethoscope,
  IconWorld,
} from "@tabler/icons-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { cn } from "#/lib/utils";
import type { McpServerView, McpTestResponse, ApiErrorBody } from "./types";
import { STATUS_META } from "./types";

type ActionState =
  | { kind: "idle" }
  | { kind: "pending"; label: string }
  | { kind: "success"; label: string }
  | { kind: "error"; label: string };

interface McpServerCardProps {
  server: McpServerView;
  onChanged: () => void;
}

export function McpServerCard({ server, onChanged }: McpServerCardProps) {
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const status = STATUS_META[server.status] ?? STATUS_META.error;

  async function runAction(label: string, fn: () => Promise<Response>) {
    setAction({ kind: "pending", label });
    try {
      const response = await fn();
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
        throw new Error(body.error ?? "Action failed");
      }
      setAction({ kind: "success", label });
      onChanged();
      window.setTimeout(() => setAction({ kind: "idle" }), 1800);
    } catch (err) {
      setAction({
        kind: "error",
        label: err instanceof Error ? err.message : "Action failed",
      });
      window.setTimeout(() => setAction({ kind: "idle" }), 3200);
    }
  }

  /** Like runAction but the success message comes from the parsed JSON body. */
  async function runJsonAction(
    label: string,
    fn: () => Promise<Response>,
    onSuccess: (body: unknown, res: Response) => ActionState,
  ) {
    setAction({ kind: "pending", label });
    try {
      const response = await fn();
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const errBody = (body ?? {}) as ApiErrorBody;
        throw new Error(errBody.error ?? "Action failed");
      }
      const next = onSuccess(body, response);
      setAction(next);
      onChanged();
      window.setTimeout(() => setAction({ kind: "idle" }), 3200);
    } catch (err) {
      setAction({
        kind: "error",
        label: err instanceof Error ? err.message : "Action failed",
      });
      window.setTimeout(() => setAction({ kind: "idle" }), 3200);
    }
  }

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-3 border bg-card p-4 text-card-foreground transition-all",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-300",
        "hover:border-foreground/20 hover:shadow-sm",
        server.status === "error" && "border-destructive/40",
      )}
    >
      {/* Status dot in the corner */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "mt-1 inline-block size-2 shrink-0 rounded-full",
              status.dot,
              server.status === "pending" && "animate-pulse",
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{server.name}</p>
            <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
              <IconWorld className="size-3 shrink-0" />
              <span className="truncate">{server.serverUrl}</span>
            </p>
          </div>
        </div>
        <Badge className={cn("shrink-0", status.tone)}>{status.label}</Badge>
      </div>

      {server.resource.name && (
        <p className="truncate text-xs text-muted-foreground">
          {server.resource.name}
          {server.resource.description ? ` — ${server.resource.description}` : ""}
        </p>
      )}

      {server.lastError && server.status === "error" && (
        <p className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="truncate">{server.lastError}</span>
        </p>
      )}

      {server.lastTestedAt && (
        <p className="text-xs text-muted-foreground">
          Last checked {new Date(server.lastTestedAt).toLocaleString()}
        </p>
      )}

      {/* Action feedback strip */}
      {action.kind !== "idle" && (
        <div
          className={cn(
            "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs",
            action.kind === "pending" && "bg-muted text-muted-foreground",
            action.kind === "success" &&
              "border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            action.kind === "error" &&
              "border border-destructive/30 bg-destructive/10 text-destructive",
          )}
          role={action.kind === "error" ? "alert" : "status"}
        >
          {action.kind === "pending" && <IconLoader2 className="size-3.5 animate-spin" />}
          {action.kind === "success" && <IconCheck className="size-3.5" />}
          {action.kind === "error" && <IconAlertTriangle className="size-3.5" />}
          <span className="truncate">{action.label}</span>
        </div>
      )}

      {/* Actions */}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
        {server.status === "active" && (
          <Button
            variant="outline"
            size="sm"
            disabled={action.kind === "pending"}
            onClick={() =>
              void runJsonAction(
                "Testing",
                () => fetch(`/api/mcp/test/${server.id}`, { method: "POST" }),
                (body) => {
                  const test = body as McpTestResponse;
                  return {
                    kind: test?.ok ? "success" : "error",
                    label: test?.ok ? "Connection verified" : (test?.message ?? "Test failed"),
                  };
                },
              )
            }
          >
            <IconStethoscope className="size-3.5" />
            Test
          </Button>
        )}
        {(server.status === "error" || server.status === "pending") && (
          <Button
            variant="outline"
            size="sm"
            disabled={action.kind === "pending"}
            onClick={() =>
              void runJsonAction(
                "Starting reconnect",
                () => fetch(`/api/mcp/reconnect/${server.id}`, { method: "POST" }),
                (body) => {
                  const redirect = body as { authorizationUrl?: string };
                  if (redirect.authorizationUrl) {
                    window.location.assign(redirect.authorizationUrl);
                  }
                  return { kind: "success" as const, label: "Redirecting to authorize…" };
                },
              )
            }
          >
            <IconRefresh className="size-3.5" />
            {server.status === "pending" ? "Authorize" : "Reconnect"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={action.kind === "pending"}
          onClick={() => setEditOpen(true)}
        >
          <IconEdit className="size-3.5" />
          Edit
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={action.kind === "pending"}
          onClick={() => setConfirmDisconnect(true)}
        >
          <IconPlugConnectedX className="size-3.5" />
          Disconnect
        </Button>
      </div>

      <EditDialog
        server={server}
        open={editOpen}
        onOpenChange={setEditOpen}
        onChanged={onChanged}
      />
      <DisconnectDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        onConfirm={() =>
          void runAction("Disconnecting", () =>
            fetch(`/api/mcp/disconnect/${server.id}`, { method: "DELETE" }),
          )
        }
        busy={action.kind === "pending"}
      />
    </div>
  );
}

function EditDialog({
  server,
  open,
  onOpenChange,
  onChanged,
}: {
  server: McpServerView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(server.name);
  const [serverUrl, setServerUrl] = useState(server.serverUrl);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      setName(server.name);
      setServerUrl(server.serverUrl);
      setError(undefined);
    }
  }, [open, server.name, server.serverUrl]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/mcp/edit/${server.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || undefined,
          serverUrl: serverUrl.trim() || undefined,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
        throw new Error(body.error ?? "Unable to save changes");
      }
      onOpenChange(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save changes");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit MCP server</DialogTitle>
          <DialogDescription>
            Changing the URL will require you to re-authorize this server.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="edit-name">Name</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
              maxLength={80}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="edit-url">Server URL</Label>
            <Input
              id="edit-url"
              type="url"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              disabled={pending}
              spellCheck={false}
            />
          </div>
          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <IconLoader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DisconnectDialog({
  open,
  onOpenChange,
  onConfirm,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Disconnect MCP server?</DialogTitle>
          <DialogDescription>
            Tokens are revoked with the server and removed from your account. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy && <IconLoader2 className="size-4 animate-spin" />}
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
