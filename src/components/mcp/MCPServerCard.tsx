import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";
import {
  Globe,
  Link,
  Plug2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff,
  AlertTriangle,
  Loader2,
} from "lucide-react";

export interface MCPServerData {
  id: string;
  name: string;
  serverUrl: string;
  status: "connected" | "disconnected" | "error" | "testing";
  hasCredentials: boolean;
  oauthProvider: string | null;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MCPServerCardProps {
  server: MCPServerData;
  onConnect: (id: string) => void;
  onTest: (id: string) => void;
  onEdit: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDelete: (id: string) => void;
  isPending?: boolean;
}

function StatusBadge({ status }: { status: MCPServerData["status"] }) {
  const config = {
    connected: { icon: Wifi, label: "Connected", variant: "default" as const },
    disconnected: { icon: WifiOff, label: "Disconnected", variant: "secondary" as const },
    error: { icon: AlertTriangle, label: "Error", variant: "destructive" as const },
    testing: { icon: Loader2, label: "Testing", variant: "secondary" as const },
  }[status];

  const Icon = config.icon;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        status === "connected" && "border-primary/40 bg-primary/10 text-primary",
        status === "disconnected" && "border-border bg-muted text-muted-foreground",
        status === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
        status === "testing" && "border-border bg-muted text-muted-foreground",
      )}
    >
      <Icon className={cn("size-3", status === "testing" && "animate-spin")} />
      {config.label}
    </div>
  );
}

export function MCPServerCard({
  server,
  onConnect,
  onTest,
  onEdit,
  onDisconnect,
  onDelete,
  isPending,
}: MCPServerCardProps) {
  const isConnected = server.status === "connected";
  const hasCredentials = server.hasCredentials;

  return (
    <Card
      className={cn(
        "group/card relative transition-all duration-300 hover:shadow-md hover:-translate-y-0.5",
        server.status === "connected" && "border-primary/30",
      )}
    >
      {isConnected && (
        <div className="absolute -top-px left-4 right-4 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
      )}
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-base font-heading">{server.name}</CardTitle>
            <CardDescription className="mt-1 flex items-center gap-1.5 font-mono text-xs">
              <Globe className="size-3 shrink-0" />
              <span className="truncate">{new URL(server.serverUrl).hostname}</span>
            </CardDescription>
          </div>
          <StatusBadge status={server.status} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 space-y-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Link className="size-3 shrink-0" />
            <span className="truncate font-mono">{server.serverUrl}</span>
          </div>
          {server.lastTestedAt && (
            <div className="flex items-center gap-1.5">
              <RefreshCw className="size-3 shrink-0" />
              <span>Last tested {new Date(server.lastTestedAt).toLocaleDateString()}</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {!isConnected || !hasCredentials ? (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="xs" onClick={() => onConnect(server.id)} disabled={isPending}>
                    <Plug2 className="size-3" />
                    Connect
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isConnected
                    ? "Re-authenticate with this MCP server"
                    : "Start OAuth flow to connect"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onTest(server.id)}
                    disabled={isPending}
                  >
                    <ShieldCheck className="size-3" />
                    Test
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Verify connection to MCP server</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onEdit(server.id)}
                  disabled={isPending}
                >
                  Edit
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit server name or URL</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {isConnected && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => onDisconnect(server.id)}
                    disabled={isPending}
                  >
                    <WifiOff className="size-3" />
                    Disconnect
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Remove stored credentials</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="ml-auto text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(server.id)}
                  disabled={isPending}
                >
                  <Trash2 className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete this MCP server</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </CardContent>
    </Card>
  );
}
