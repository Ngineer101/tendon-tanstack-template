import { useState } from "react";
import {
  IconServer,
  IconPlugConnected,
  IconPlugConnectedX,
  IconAlertTriangle,
  IconPencil,
  IconTrash,
  IconRefresh,
  IconPlayerPlay,
  IconLock,
  IconPlus,
} from "@tabler/icons-react";
import { Button } from "#/components/ui/button";
import { Badge } from "#/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { cn } from "#/lib/utils";

export interface McpServer {
  id: string;
  label: string;
  url: string;
  authType: string | null;
  status: string;
  hasAuth: boolean;
  createdAt: number;
  updatedAt: number;
}

interface McpServerCardProps {
  server: McpServer;
  onTest: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, label: string, url: string) => void;
  onOAuth: (id: string) => void;
  onReconnect: (id: string) => void;
  testing: string | null;
  connecting: string | null;
}

function statusConfig(status: string) {
  switch (status) {
    case "connected":
      return {
        icon: IconPlugConnected,
        label: "Connected",
        badgeClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        iconClass: "text-emerald-400",
      };
    case "error":
      return {
        icon: IconAlertTriangle,
        label: "Error",
        badgeClass: "border-destructive/30 bg-destructive/10 text-destructive",
        iconClass: "text-destructive",
      };
    default:
      return {
        icon: IconPlugConnectedX,
        label: "Disconnected",
        badgeClass: "border-muted-foreground/30 bg-muted/50 text-muted-foreground",
        iconClass: "text-muted-foreground",
      };
  }
}

export function McpServerCard({
  server,
  onTest,
  onDelete,
  onEdit,
  onOAuth,
  onReconnect,
  testing,
  connecting,
}: McpServerCardProps) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editLabel, setEditLabel] = useState(server.label);
  const [editUrl, setEditUrl] = useState(server.url);
  const status = statusConfig(server.status);
  const StatusIcon = status.icon;
  const isBusy = testing === server.id || connecting === server.id;

  return (
    <div
      className={cn(
        "group relative border bg-card text-card-foreground transition-all duration-200",
        "hover:border-primary/30 hover:shadow-sm",
        "animate-in fade-in-0 zoom-in-95",
      )}
    >
      <div className="p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <IconServer className="size-4 shrink-0 text-muted-foreground" />
            <h3 className="font-medium text-sm truncate">{server.label}</h3>
          </div>
          <Badge className={cn("shrink-0 text-[10px] px-1.5 py-0", status.badgeClass)}>
            <StatusIcon className="size-3 mr-1" />
            {status.label}
          </Badge>
        </div>

        <p className="mt-2 text-xs text-muted-foreground truncate font-mono">{server.url}</p>

        <div className="mt-3 flex items-center gap-1 text-[10px] text-muted-foreground">
          {server.hasAuth && <IconLock className="size-3" />}
          {server.authType === "oauth" && "OAuth 2.0"}
        </div>

        <div className="mt-4 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          <button
            onClick={() => onTest(server.id)}
            disabled={isBusy}
            className="inline-flex items-center justify-center size-7 rounded-md hover:bg-muted transition-colors disabled:opacity-50"
            title="Test connection"
          >
            <IconPlayerPlay
              className={cn("size-3.5", isBusy && testing === server.id && "animate-pulse")}
            />
          </button>
          {server.status === "error" && (
            <button
              onClick={() => onReconnect(server.id)}
              disabled={isBusy}
              className="inline-flex items-center justify-center size-7 rounded-md hover:bg-muted transition-colors disabled:opacity-50"
              title="Reconnect"
            >
              <IconRefresh
                className={cn("size-3.5", isBusy && connecting === server.id && "animate-spin")}
              />
            </button>
          )}
          <button
            onClick={() => {
              setEditLabel(server.label);
              setEditUrl(server.url);
              setEditOpen(true);
            }}
            disabled={isBusy}
            className="inline-flex items-center justify-center size-7 rounded-md hover:bg-muted transition-colors disabled:opacity-50"
            title="Edit"
          >
            <IconPencil className="size-3.5" />
          </button>
          {!server.hasAuth && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onOAuth(server.id)}
              disabled={isBusy}
              className="h-7 gap-1 text-[10px] hover:text-primary"
            >
              <IconLock className="size-3" />
              Connect
            </Button>
          )}
          <div className="flex-1" />
          <button
            onClick={() => setDeleteOpen(true)}
            disabled={isBusy}
            className="inline-flex items-center justify-center size-7 rounded-md hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
            title="Disconnect"
          >
            <IconTrash className="size-3.5" />
          </button>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>Disconnect server</DialogTitle>
            <DialogDescription>
              Remove &quot;{server.label}&quot; from your MCP servers. You can reconnect it later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              variant="destructive"
              onClick={() => {
                onDelete(server.id);
                setDeleteOpen(false);
              }}
            >
              <IconTrash className="size-4" />
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>Edit server</DialogTitle>
            <DialogDescription>Update the label or URL for this MCP server.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div>
              <Label htmlFor="edit-label">Label</Label>
              <Input
                id="edit-label"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                placeholder="My MCP Server"
              />
            </div>
            <div>
              <Label htmlFor="edit-url">URL</Label>
              <Input
                id="edit-url"
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                placeholder="https://mcp.example.com"
              />
            </div>
          </div>
          <DialogFooter showCloseButton>
            <Button
              onClick={() => {
                onEdit(server.id, editLabel, editUrl);
                setEditOpen(false);
              }}
              disabled={!editLabel.trim() || !editUrl.trim() || isBusy}
            >
              <IconPencil className="size-4" />
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface AddMcpServerDialogProps {
  onAdd: (label: string, url: string) => void;
  disabled?: boolean;
  limitReached?: boolean;
  limitMessage?: string;
}

export function AddMcpServerDialog({
  onAdd,
  disabled,
  limitReached,
  limitMessage,
}: AddMcpServerDialogProps) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className="animate-in fade-in-0 slide-in-from-bottom-2"
        >
          <IconPlus className="size-4" />
          Connect server
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Connect MCP server</DialogTitle>
          <DialogDescription>
            Enter the URL of your MCP server to connect it to this application.
          </DialogDescription>
        </DialogHeader>
        {limitReached && (
          <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {limitMessage}
          </p>
        )}
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="label">Label</Label>
            <Input
              id="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="My MCP Server"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="url">Server URL</Label>
            <Input
              id="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Must be a valid HTTPS URL. OAuth can be configured after connecting.
            </p>
          </div>
        </div>
        <DialogFooter showCloseButton>
          <Button
            onClick={() => {
              onAdd(label, url);
              setLabel("");
              setUrl("");
              setOpen(false);
            }}
            disabled={!label.trim() || !url.trim() || limitReached}
          >
            <IconPlus className="size-4" />
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
