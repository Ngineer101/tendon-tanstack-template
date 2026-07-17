import { useState, useCallback } from "react";

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

interface McpEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: { id: string; label: string; serverUrl: string };
  onUpdated: () => void;
}

export function McpEditDialog({ open, onOpenChange, server, onUpdated }: McpEditDialogProps) {
  const [label, setLabel] = useState(server.label);
  const [serverUrl, setServerUrl] = useState(server.serverUrl);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setError(undefined);
    setSaving(true);

    try {
      const response = await fetch(`/api/mcp/servers/${server.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: label.trim() || undefined,
          serverUrl: serverUrl.trim() || undefined,
        }),
      });

      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error ?? "Unable to update server");
      }

      onOpenChange(false);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update server");
    } finally {
      setSaving(false);
    }
  }, [label, serverUrl, server.id, onOpenChange, onUpdated]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setLabel(server.label);
          setServerUrl(server.serverUrl);
          setError(undefined);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit MCP server</DialogTitle>
          <DialogDescription>
            Update the display name or URL for this server. Changing the URL will require
            re-authentication.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {error && (
            <div className="border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-edit-label">Display name</Label>
            <Input
              id="mcp-edit-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={128}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-edit-url">Server URL</Label>
            <Input
              id="mcp-edit-url"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              type="url"
            />
          </div>
        </div>

        <DialogFooter showCloseButton>
          <Button onClick={handleSave} disabled={!label.trim() || saving}>
            {saving ? "Saving..." : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
