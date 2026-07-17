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
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import type { McpServerDto } from "#/lib/mcp/config";

import { McpApiError, useUpdateServer } from "./use-mcp-servers";

interface EditServerDialogProps {
  server: McpServerDto | null;
  onOpenChange: (open: boolean) => void;
  /** Called when the URL changed and the server now needs re-authorization. */
  onReconnectRequested: (server: McpServerDto) => void;
}

export function EditServerDialog({
  server,
  onOpenChange,
  onReconnectRequested,
}: EditServerDialogProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const updateServer = useUpdateServer();

  useEffect(() => {
    if (!server) return;
    setName(server.name);
    setUrl(server.url);
    setError(undefined);
  }, [server]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!server) return;
    setError(undefined);

    const changes: { name?: string; url?: string } = {};
    if (name.trim() !== server.name) changes.name = name;
    if (url.trim() !== server.url) changes.url = url;

    if (Object.keys(changes).length === 0) {
      onOpenChange(false);
      return;
    }

    updateServer.mutate(
      { serverId: server.id, ...changes },
      {
        onSuccess: (result) => {
          onOpenChange(false);
          if (changes.url && result.server.status === "pending_auth") {
            onReconnectRequested(result.server);
          }
        },
        onError: (reason) => {
          if (reason instanceof McpApiError) {
            setError(reason.message);
          } else {
            setError("Unable to save changes");
          }
        },
      },
    );
  }

  return (
    <Dialog
      open={server !== null}
      onOpenChange={(next) => !updateServer.isPending && onOpenChange(next)}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Edit server</DialogTitle>
            <DialogDescription>
              Renaming is instant. Changing the URL clears the stored credentials — you'll be asked
              to authorize again.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-edit-name">Name</Label>
            <Input
              id="mcp-edit-name"
              autoComplete="off"
              maxLength={80}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-edit-url">Server URL</Label>
            <Input
              id="mcp-edit-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>

          {url !== server?.url && (
            <p className="border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 motion-safe:animate-in motion-safe:fade-in-0 dark:text-amber-400">
              Changing the URL requires re-authorization with the new server.
            </p>
          )}

          {error && (
            <p className="border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive motion-safe:animate-in motion-safe:fade-in-0">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={updateServer.isPending} className="min-w-28">
              {updateServer.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save changes"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
