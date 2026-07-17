import { useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plug,
  PlugZap,
  Trash2,
  Unplug,
  XCircle,
} from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { cn } from "#/lib/utils";
import type { McpServerPublic } from "#/lib/mcp/types";

interface McpServerCardProps {
  server: McpServerPublic;
  actioning: boolean;
  onTest: (id: string) => unknown;
  onReconnect: (id: string) => unknown;
  onEdit: (id: string, patch: { name: string; serverUrl: string }) => unknown;
  onDisconnect: (id: string) => unknown;
  onDelete: (id: string) => unknown;
}

export function McpServerCard({
  server,
  actioning,
  onTest,
  onReconnect,
  onEdit,
  onDisconnect,
  onDelete,
}: McpServerCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const [editName, setEditName] = useState(server.name);
  const [editUrl, setEditUrl] = useState(server.serverUrl);

  const statusBadge = statusBadgeFor(server);

  return (
    <Card className="group flex h-full flex-col transition-shadow hover:shadow-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate">{server.name}</CardTitle>
            <CardDescription className="mt-1 truncate" title={server.serverUrl}>
              {server.serverUrl}
            </CardDescription>
          </div>
          {statusBadge}
        </div>
      </CardHeader>

      <CardContent className="mt-auto flex flex-col gap-3">
        {server.lastError && server.status === "error" && (
          <p className="line-clamp-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {server.lastError}
          </p>
        )}
        {server.status === "disconnected" && (
          <p className="rounded-md border border-muted-foreground/20 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Credentials were cleared. Reconnect to authorize again.
          </p>
        )}

        <div className="flex items-center gap-2">
          {server.status === "connected" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  setTestRunning(true);
                  try {
                    await onTest(server.id);
                  } finally {
                    setTestRunning(false);
                  }
                }}
                disabled={actioning || testRunning}
              >
                {testRunning ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-3.5" />
                )}
                Test
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onReconnect(server.id)}
              disabled={actioning}
            >
              <PlugZap className="size-3.5" />
              Reconnect
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditName(server.name);
              setEditUrl(server.serverUrl);
              setEditOpen(true);
            }}
            disabled={actioning}
          >
            <Pencil className="size-3.5" />
            Edit
          </Button>

          <div className="relative ml-auto">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="More actions"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              disabled={actioning}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
            {menuOpen && (
              <>
                {/* Click-away layer */}
                <div
                  className="fixed inset-0 z-10"
                  role="button"
                  tabIndex={-1}
                  aria-hidden
                  onClick={() => setMenuOpen(false)}
                />
                <div
                  className="absolute right-0 z-20 mt-1 w-44 animate-in fade-in-0 zoom-in-95 border bg-popover p-1 text-sm ring-1 ring-foreground/10 duration-100"
                  role="menu"
                >
                  {server.status === "connected" && (
                    <MenuButton
                      icon={<Unplug className="size-3.5" />}
                      label="Disconnect"
                      onClick={() => {
                        setMenuOpen(false);
                        void onDisconnect(server.id);
                      }}
                    />
                  )}
                  <MenuButton
                    icon={<Trash2 className="size-3.5" />}
                    label="Delete"
                    destructive
                    onClick={() => {
                      setMenuOpen(false);
                      setDeleteOpen(true);
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {server.status === "pending" && (
          <p className="text-xs text-muted-foreground">
            Authorization pending. Reconnect to retry.
          </p>
        )}
      </CardContent>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit MCP server</DialogTitle>
            <DialogDescription>
              Changing the URL resets the connection and asks you to re-authorize.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3 py-1"
            onSubmit={(e) => {
              e.preventDefault();
              setEditOpen(false);
              void onEdit(server.id, { name: editName, serverUrl: editUrl });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={80}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-url">Server URL</Label>
              <Input
                id="mcp-url"
                type="url"
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                placeholder="https://example.com"
                required
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={actioning}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete MCP server?</DialogTitle>
            <DialogDescription>
              This permanently removes the server and its connection. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setDeleteOpen(false);
                void onDelete(server.id);
              }}
              disabled={actioning}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function MenuButton({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-muted",
        destructive && "text-destructive hover:bg-destructive/10",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function statusBadgeFor(server: McpServerPublic): React.ReactNode {
  switch (server.status) {
    case "connected":
      return (
        <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="size-3" />
          Connected
        </Badge>
      );
    case "pending":
      return (
        <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Plug className="size-3" />
          Pending
        </Badge>
      );
    case "disconnected":
      return (
        <Badge className="border-muted-foreground/20 bg-muted/40 text-muted-foreground">
          <Unplug className="size-3" />
          Disconnected
        </Badge>
      );
    case "error":
      return (
        <Badge className="border-destructive/30 bg-destructive/10 text-destructive">
          <XCircle className="size-3" />
          Error
        </Badge>
      );
    default:
      return null;
  }
}
