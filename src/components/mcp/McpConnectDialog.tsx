import { useState, useCallback } from "react";
import { Globe, Loader2, AlertCircle } from "lucide-react";

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

interface McpConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}

export function McpConnectDialog({ open, onOpenChange, onConnected }: McpConnectDialogProps) {
  const [label, setLabel] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [error, setError] = useState<string>();
  const [step, setStep] = useState<"form" | "connecting" | "error">("form");

  const handleSubmit = useCallback(async () => {
    setError(undefined);
    setStep("connecting");

    try {
      const response = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim(), serverUrl: serverUrl.trim() }),
      });

      const result = (await response.json()) as {
        authorizationUrl?: string;
        error?: string;
      };

      if (!response.ok || !result.authorizationUrl) {
        throw new Error(result.error ?? "Unable to initiate MCP connection");
      }

      const popup = window.open(
        result.authorizationUrl,
        "mcp-oauth",
        "width=600,height=700,left=" +
          (window.screenX + (window.outerWidth - 600) / 2) +
          ",top=" +
          (window.screenY + (window.outerHeight - 700) / 2),
      );

      if (!popup) {
        setError("Popup blocked. Please allow popups for this site and try again.");
        setStep("error");
        return;
      }

      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          onOpenChange(false);
          onConnected();
          resetForm();
        }
      }, 500);

      window.addEventListener(
        "message",
        (event) => {
          if (event.data === "mcp-oauth-complete") {
            clearInterval(checkClosed);
            popup.close();
            onOpenChange(false);
            onConnected();
            resetForm();
          }
        },
        { once: true },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to initiate MCP connection");
      setStep("error");
    }
  }, [label, serverUrl, onOpenChange, onConnected]);

  function resetForm() {
    setLabel("");
    setServerUrl("");
    setError(undefined);
    setStep("form");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) resetForm();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect MCP server</DialogTitle>
          <DialogDescription>
            Enter the HTTPS URL of your MCP server to discover its OAuth configuration and connect.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {step === "connecting" && (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="relative">
                <div className="size-12 rounded-full border-2 border-primary/20" />
                <Loader2 className="absolute inset-0 m-auto size-6 animate-spin text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">Discovering OAuth configuration...</p>
            </div>
          )}

          {step === "error" && (
            <div className="flex items-start gap-3 border border-destructive/20 bg-destructive/5 p-3 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div>
                <p className="font-medium text-destructive">Connection failed</p>
                {error && <p className="mt-0.5 text-muted-foreground">{error}</p>}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto shrink-0"
                onClick={() => setStep("form")}
              >
                Try again
              </Button>
            </div>
          )}

          {step === "form" && (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-label">Display name</Label>
                <Input
                  id="mcp-label"
                  placeholder="My MCP server"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={128}
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-url">Server URL</Label>
                <Input
                  id="mcp-url"
                  placeholder="https://mcp.example.com"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  type="url"
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter showCloseButton>
          {step === "form" && (
            <Button onClick={handleSubmit} disabled={!label.trim() || !serverUrl.trim()}>
              <Globe className="size-4" />
              Discover and connect
            </Button>
          )}
          {step === "connecting" && (
            <Button disabled>
              <Loader2 className="size-4 animate-spin" />
              Connecting...
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
