import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { apiRequest, type McpServerDto } from "./mcp-api";

interface DisconnectServerDialogProps {
  server: McpServerDto | null;
  onOpenChange: (open: boolean) => void;
  onDisconnected: (serverId: string) => void;
}

export function DisconnectServerDialog({
  server,
  onOpenChange,
  onDisconnected,
}: DisconnectServerDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (server) {
      setError(null);
      setDeleting(false);
    }
  }, [server]);

  async function handleDisconnect() {
    if (!server || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await apiRequest(`/api/mcp/servers/${server.id}`, { method: "DELETE" });
      onDisconnected(server.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not disconnect the server");
      setDeleting(false);
    }
  }

  return (
    <Dialog open={!!server} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect {server?.name}?</DialogTitle>
          <DialogDescription>
            This removes the server and permanently deletes its encrypted credentials. Chat sessions
            will no longer be able to use it. You can always connect it again.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive animate-in fade-in-0 duration-300">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep server
          </Button>
          <Button variant="destructive" onClick={handleDisconnect} disabled={deleting}>
            {deleting && <Loader2 className="size-4 animate-spin" />}
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
