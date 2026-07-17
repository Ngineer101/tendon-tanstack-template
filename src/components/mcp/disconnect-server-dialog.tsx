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
import type { McpServerDto } from "#/lib/mcp/config";

import { useDeleteServer } from "./use-mcp-servers";

interface DisconnectServerDialogProps {
  server: McpServerDto | null;
  onOpenChange: (open: boolean) => void;
}

export function DisconnectServerDialog({ server, onOpenChange }: DisconnectServerDialogProps) {
  const [error, setError] = useState<string>();
  const deleteServer = useDeleteServer();

  useEffect(() => {
    if (server) setError(undefined);
  }, [server]);

  function handleDisconnect() {
    if (!server) return;
    setError(undefined);
    deleteServer.mutate(server.id, {
      onSuccess: () => onOpenChange(false),
      onError: (reason) =>
        setError(reason instanceof Error ? reason.message : "Unable to disconnect the server"),
    });
  }

  return (
    <Dialog
      open={server !== null}
      onOpenChange={(next) => !deleteServer.isPending && onOpenChange(next)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect {server?.name}?</DialogTitle>
          <DialogDescription>
            This removes the server and permanently deletes its stored credentials. Chat sessions
            will no longer be able to use it. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive motion-safe:animate-in motion-safe:fade-in-0">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleteServer.isPending}
          >
            Keep server
          </Button>
          <Button
            variant="destructive"
            onClick={handleDisconnect}
            disabled={deleteServer.isPending}
            className="min-w-28"
          >
            {deleteServer.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Removing…
              </>
            ) : (
              "Disconnect"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
