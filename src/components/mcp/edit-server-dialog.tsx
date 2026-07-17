import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

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
import { apiRequest, type McpServerDto } from "./mcp-api";

interface EditServerDialogProps {
  server: McpServerDto | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (server: McpServerDto, urlChanged: boolean) => void;
}

export function EditServerDialog({ server, onOpenChange, onSaved }: EditServerDialogProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (server) {
      setName(server.name);
      setUrl(server.url);
      setError(null);
      setSaving(false);
    }
  }, [server]);

  const urlChanged = !!server && url.trim() !== server.url;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!server || saving) return;

    setSaving(true);
    setError(null);
    try {
      const result = await apiRequest<{ server: McpServerDto }>(`/api/mcp/servers/${server.id}`, {
        method: "PATCH",
        body: { name, ...(urlChanged ? { url } : {}) },
      });
      onSaved(result.server, urlChanged);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save changes");
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!server} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit server</DialogTitle>
          <DialogDescription>
            Update the display name or endpoint for this MCP server.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-edit-name">Display name</Label>
            <Input
              id="mcp-edit-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-edit-url">Server URL</Label>
            <Input
              id="mcp-edit-url"
              type="url"
              inputMode="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
            />
          </div>

          {urlChanged && (
            <p className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 animate-in fade-in-0 slide-in-from-top-1 duration-300 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              Changing the URL clears the stored credentials. You'll need to reconnect and authorize
              the server again.
            </p>
          )}

          {error && (
            <p className="border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive animate-in fade-in-0 duration-300">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
