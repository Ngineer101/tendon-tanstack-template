import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { PlugZap, Plus, Sparkles, X } from "lucide-react";

import { Button } from "#/components/ui/button";
import { Card } from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import { FREE_MCP_SERVER_LIMIT, type McpServerDto } from "#/lib/mcp/config";
import { cn } from "#/lib/utils";

import { ConnectServerDialog } from "./connect-server-dialog";
import { DisconnectServerDialog } from "./disconnect-server-dialog";
import { EditServerDialog } from "./edit-server-dialog";
import { McpServerCard } from "./server-card";
import { useMcpServers, useTestServer } from "./use-mcp-servers";

const MCP_BANNERS: Record<string, { className: string; message: string }> = {
  connected: {
    className: "border-primary/30 bg-primary/10",
    message: "MCP server connected. It's ready to use in your chat sessions.",
  },
  denied: {
    className: "border-amber-500/30 bg-amber-500/10",
    message: "Authorization was cancelled. The server is saved — reconnect whenever you're ready.",
  },
  error: {
    className: "border-destructive/30 bg-destructive/10",
    message: "Authorization couldn't be completed. Details are shown on the server below.",
  },
};

export function McpServersSection({ banner }: { banner?: string }) {
  const navigate = useNavigate();
  const serversQuery = useMcpServers();
  const testServer = useTestServer();

  const [connectOpen, setConnectOpen] = useState(false);
  const [reconnectTarget, setReconnectTarget] = useState<McpServerDto | null>(null);
  const [editTarget, setEditTarget] = useState<McpServerDto | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<McpServerDto | null>(null);
  const [testingServerId, setTestingServerId] = useState<string>();
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    setBannerDismissed(false);
  }, [banner]);

  const servers = serversQuery.data?.servers ?? [];
  const usage = serversQuery.data?.usage;
  const atLimit = usage ? usage.limit !== null && usage.count >= usage.limit : false;

  const activeBanner = banner && !bannerDismissed ? MCP_BANNERS[banner] : undefined;

  function dismissBanner() {
    setBannerDismissed(true);
    void navigate({
      to: "/dashboard",
      search: { mcp: undefined },
      replace: true,
    });
  }

  function handleReconnect(server: McpServerDto) {
    setReconnectTarget(server);
  }

  function handleTest(server: McpServerDto) {
    setTestingServerId(server.id);
    testServer.mutate(server.id, { onSettled: () => setTestingServerId(undefined) });
  }

  return (
    <section className="mt-12">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
            MCP connections
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">MCP servers</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Connect Model Context Protocol servers to automate your workflow from chat. OAuth
            credentials are encrypted before they're stored.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {usage && (
            <span
              className={cn(
                "text-xs whitespace-nowrap text-muted-foreground tabular-nums",
                atLimit && "text-amber-700 dark:text-amber-400",
              )}
            >
              {usage.limit === null
                ? `${usage.count} connected · unlimited plan`
                : `${usage.count} of ${usage.limit} servers used`}
            </span>
          )}
          <Button onClick={() => setConnectOpen(true)} disabled={atLimit}>
            <Plus className="size-4" />
            Connect server
          </Button>
        </div>
      </div>

      {activeBanner && (
        <div
          className={cn(
            "mt-6 flex items-start justify-between gap-3 border px-4 py-3 text-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1",
            activeBanner.className,
          )}
        >
          <p>{activeBanner.message}</p>
          <button
            type="button"
            onClick={dismissBanner}
            aria-label="Dismiss"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {serversQuery.isError && (
        <p className="mt-6 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
          Unable to load your MCP servers. Refresh the page to try again.
        </p>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {serversQuery.isPending ? (
          Array.from({ length: 3 }, (_, index) => (
            <Card key={index} className="p-6">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-8" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
              <Skeleton className="mt-6 h-7 w-24" />
            </Card>
          ))
        ) : (
          <>
            {servers.map((server, index) => (
              <McpServerCard
                key={server.id}
                server={server}
                index={index}
                pendingAction={testingServerId === server.id ? "test" : null}
                onTest={handleTest}
                onReconnect={handleReconnect}
                onEdit={setEditTarget}
                onDisconnect={setDisconnectTarget}
              />
            ))}

            {!atLimit ? (
              <button
                type="button"
                onClick={() => setConnectOpen(true)}
                className={cn(
                  "group flex min-h-44 flex-col items-center justify-center gap-2 border border-dashed px-6 py-8 text-center transition-all duration-200",
                  "text-muted-foreground hover:-translate-y-0.5 hover:border-primary/50 hover:text-primary",
                  servers.length === 0 && "md:col-span-2 lg:col-span-3",
                )}
              >
                <span className="flex size-9 items-center justify-center border bg-muted transition-all duration-200 group-hover:scale-110 group-hover:border-primary/40">
                  <PlugZap className="size-4" />
                </span>
                <span className="text-sm font-medium">
                  {servers.length === 0
                    ? "Connect your first MCP server"
                    : "Connect another server"}
                </span>
                <span className="max-w-56 text-xs text-muted-foreground">
                  OAuth discovery, encrypted credential storage, one-click reconnect
                </span>
              </button>
            ) : (
              <Link
                to="/billing"
                search={{ checkout: undefined }}
                className={cn(
                  "group flex min-h-44 flex-col items-center justify-center gap-2 border border-dashed border-primary/40 bg-primary/5 px-6 py-8 text-center transition-all duration-200",
                  "hover:-translate-y-0.5 hover:border-primary/60",
                )}
              >
                <span className="flex size-9 items-center justify-center border border-primary/40 bg-background text-primary transition-transform duration-200 group-hover:scale-110">
                  <Sparkles className="size-4" />
                </span>
                <span className="text-sm font-medium">
                  Free plan includes {FREE_MCP_SERVER_LIMIT} servers
                </span>
                <span className="max-w-56 text-xs text-muted-foreground">
                  Upgrade to Pro for unlimited MCP servers
                </span>
              </Link>
            )}
          </>
        )}
      </div>

      <ConnectServerDialog open={connectOpen} onOpenChange={setConnectOpen} />
      <ConnectServerDialog
        open={reconnectTarget !== null}
        onOpenChange={(next) => !next && setReconnectTarget(null)}
        reconnectTarget={reconnectTarget}
      />
      <EditServerDialog
        server={editTarget}
        onOpenChange={(next) => !next && setEditTarget(null)}
        onReconnectRequested={handleReconnect}
      />
      <DisconnectServerDialog
        server={disconnectTarget}
        onOpenChange={(next) => !next && setDisconnectTarget(null)}
      />
    </section>
  );
}
