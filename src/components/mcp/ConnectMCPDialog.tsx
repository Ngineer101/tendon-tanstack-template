import { useState, useEffect } from "react";
import { Globe, Loader2, Plug2, Server } from "lucide-react";

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

interface ConnectMCPDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  initialName?: string;
  initialUrl?: string;
  onSave: (data: { name: string; serverUrl: string }) => Promise<void>;
}

export function ConnectMCPDialog({
  open,
  onOpenChange,
  mode,
  initialName = "",
  initialUrl = "",
  onSave,
}: ConnectMCPDialogProps) {
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setUrl(initialUrl);
      setError(undefined);
      setSaving(false);
    }
  }, [open, initialName, initialUrl]);

  async function handleSave() {
    setError(undefined);

    if (!name.trim()) {
      setError("Server name is required");
      return;
    }

    if (!url.trim()) {
      setError("Server URL is required");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setError("Please enter a valid URL (e.g. https://example.com)");
      return;
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      setError("URL must use HTTP or HTTPS");
      return;
    }

    setSaving(true);
    try {
      await onSave({ name: name.trim(), serverUrl: url.trim() });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save server");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="size-5 text-primary" />
            {mode === "create" ? "Connect MCP Server" : "Edit MCP Server"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Add an MCP server to extend your application's capabilities."
              : "Update the server name or connection URL."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mcp-name">Server name</Label>
            <Input
              id="mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My MCP Server"
              disabled={saving}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSave();
              }}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="mcp-url" className="flex items-center gap-1.5">
              <Globe className="size-3.5" />
              Server URL
            </Label>
            <Input
              id="mcp-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com"
              disabled={saving}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSave();
              }}
            />
          </div>

          {error && (
            <div className="animate-in fade-in-0 slide-in-from-top-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter showCloseButton>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Plug2 className="size-4" />}
            {mode === "create" ? "Connect" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
