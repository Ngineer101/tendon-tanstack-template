import { useState } from "react";
import { Check, Loader2, RefreshCw, Server, Trash2, Pencil } from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { McpEditDialog } from "./McpEditDialog";

interface ServerInfo {
  id: string;
  label: string;
  serverUrl: string;
  authStatus: string;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface McpServerCardProps {
  server: ServerInfo;
  onRefresh: () => void;
}

function statusBadge(status: string) {
  switch (status) {
    case "active":
      return (
        <Badge className="border-primary/40 bg-primary/10 text-primary gap-1">
          <Check className="size-3" />
          Connected
        </Badge>
      );
    case "pending":
      return (
        <Badge className="gap-1">
          <Loader2 className="size-3 animate-spin" />
          Pending
        </Badge>
      );
    case "error":
      return (
        <Badge className="border-destructive/40 bg-destructive/10 text-destructive gap-1">
          Error
        </Badge>
      );
    case "expired":
      return (
        <Badge className="border-destructive/40 bg-destructive/10 text-destructive gap-1">
          Expired
        </Badge>
      );
    default:
      return <Badge className="gap-1">{status}</Badge>;
  }
}

export function McpServerCard({ server, onRefresh }: McpServerCardProps) {
  const [testing, setTesting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [testResult, setTestResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch(`/api/mcp/servers/${server.id}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const result = (await response.json()) as {
        success?: boolean;
        error?: string;
      };

      if (response.ok && result.success) {
        setTestResult({ type: "success", message: "Connection test passed" });
      } else {
        throw new Error(result.error ?? "Connection test failed");
      }
      onRefresh();
    } catch (err) {
      setTestResult({
        type: "error",
        message: err instanceof Error ? err.message : "Connection test failed",
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleReconnect() {
    setReconnecting(true);
    try {
      const response = await fetch(`/api/mcp/servers/${server.id}/reconnect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const result = (await response.json()) as {
        authorizationUrl?: string;
        error?: string;
      };

      if (!response.ok || !result.authorizationUrl) {
        throw new Error(result.error ?? "Unable to reconnect");
      }

      const popup = window.open(
        result.authorizationUrl,
        "mcp-oauth-reconnect",
        "width=600,height=700,left=" +
          (window.screenX + (window.outerWidth - 600) / 2) +
          ",top=" +
          (window.screenY + (window.outerHeight - 700) / 2),
      );

      if (!popup) {
        throw new Error("Popup blocked. Please allow popups.");
      }

      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          onRefresh();
        }
      }, 500);
    } catch {
      // error shown via onRefresh
      onRefresh();
    } finally {
      setReconnecting(false);
    }
  }

  async function handleDisconnect() {
    if (
      !window.confirm(
        `Are you sure you want to disconnect "${server.label}"? This action cannot be undone.`,
      )
    ) {
      return;
    }

    setDisconnecting(true);
    try {
      const response = await fetch(`/api/mcp/servers/${server.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      });

      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error ?? "Unable to disconnect server");
      }

      onRefresh();
    } catch {
      onRefresh();
    } finally {
      setDisconnecting(false);
    }
  }

  const displayUrl = server.serverUrl.replace(/^https?:\/\//, "");

  return (
    <>
      <Card className="group relative transition-all duration-200 hover:border-primary/30 hover:shadow-sm">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted transition-colors group-hover:bg-primary/10">
                <Server className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
              </div>
              <CardTitle className="truncate text-sm">{server.label}</CardTitle>
            </div>
            {statusBadge(server.authStatus)}
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          <p className="truncate text-xs text-muted-foreground">{displayUrl}</p>

          {server.lastError && server.authStatus === "error" && (
            <p className="text-xs text-destructive/80 line-clamp-2">{server.lastError}</p>
          )}

          {testResult && (
            <p
              className={`text-xs ${testResult.type === "success" ? "text-primary" : "text-destructive"} animate-in fade-in slide-in-from-top-1 duration-200`}
            >
              {testResult.message}
            </p>
          )}

          <div className="mt-1 flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={handleTest}
              disabled={testing || server.authStatus === "pending"}
              title="Test connection"
            >
              {testing ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              Test
            </Button>

            <Button
              variant="ghost"
              size="xs"
              onClick={handleReconnect}
              disabled={reconnecting}
              title="Re-authenticate"
            >
              <RefreshCw className={`size-3 ${reconnecting ? "animate-spin" : ""}`} />
              Reconnect
            </Button>

            <Button variant="ghost" size="xs" onClick={() => setEditOpen(true)} title="Edit server">
              <Pencil className="size-3" />
              Edit
            </Button>

            <Button
              variant="ghost"
              size="xs"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="ml-auto text-destructive hover:text-destructive"
              title="Disconnect server"
            >
              <Trash2 className="size-3" />
              Disconnect
            </Button>
          </div>
        </CardContent>
      </Card>

      <McpEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        server={server}
        onUpdated={onRefresh}
      />
    </>
  );
}
