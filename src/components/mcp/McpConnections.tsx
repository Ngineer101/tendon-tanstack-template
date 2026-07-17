import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { IconPlugConnected, IconSparkles } from "@tabler/icons-react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { cn } from "#/lib/utils";

import { ConnectMcpDialog } from "./ConnectMcpDialog";
import { McpServerCard } from "./McpServerCard";
import { type McpServersResponse, type McpServerView, type ApiErrorBody } from "./types";

const POLL_MS = 25_000;

export function McpConnections() {
  const [data, setData] = useState<McpServersResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [flash, setFlash] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/mcp/servers");
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
        throw new Error(body.error ?? "Unable to load MCP servers");
      }
      setData((await response.json()) as McpServersResponse);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load MCP servers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const params = new URLSearchParams(window.location.search);
    if (params.get("mcp") === "connected") {
      setFlash("MCP server connected.");
      const url = new URL(window.location.href);
      url.searchParams.delete("mcp");
      window.history.replaceState(
        {},
        "",
        url.pathname + (url.search ? `?${url.searchParams}` : ""),
      );
    }
    // Light polling keeps card statuses fresh while OAuth completes in another tab.
    const interval = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(interval);
  }, [reload]);

  const servers: McpServerView[] = data?.servers ?? [];
  const isPro = data?.plan === "pro_monthly";
  const limit = data?.limit ?? null;
  const remaining = data?.remaining ?? null;
  const atLimit = limit !== null && (remaining ?? 0) <= 0;

  const usedCount = servers.filter((s) => s.status === "active" || s.status === "pending").length;

  return (
    <section
      className="animate-in fade-in-0 slide-in-from-bottom-2 duration-500 mt-12"
      aria-labelledby="mcp-heading"
    >
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Integrations</p>
          <h2 id="mcp-heading" className="mt-2 text-2xl font-semibold tracking-tight">
            MCP servers
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Connect Model Context Protocol servers to extend your chat sessions with tools and
            resources you control.
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <Badge className={cn("font-mono text-xs")}>
            {isPro ? (
              <>
                <IconSparkles className="size-3 text-primary" />
                Unlimited (Pro)
              </>
            ) : (
              <>
                {usedCount}/{limit} servers
              </>
            )}
          </Badge>
          <Button onClick={() => setConnectOpen(true)} disabled={atLimit}>
            <IconPlugConnected className="size-4" />
            Connect server
          </Button>
        </div>
      </div>

      {flash && (
        <p className="animate-in fade-in-0 slide-in-from-top-1 duration-300 mt-4 border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {flash}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-4 border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {atLimit && !isPro && (
        <p className="mt-4 rounded-md border border-primary/30 bg-primary/10 px-4 py-2 text-sm">
          You’ve reached the free-plan limit of {limit} MCP servers.{" "}
          <Link to="/billing" search={{ checkout: undefined }} className="font-medium underline">
            Upgrade to Pro
          </Link>{" "}
          for unlimited connections.
        </p>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-md" />
          ))
        ) : servers.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center rounded-md border border-dashed px-6 py-12 text-center">
            <span className="inline-flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <IconPlugConnected className="size-5" />
            </span>
            <p className="mt-3 text-sm font-medium">No MCP servers yet</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Connect your first MCP server to unlock tools in your chat sessions.
            </p>
          </div>
        ) : (
          servers.map((server) => (
            <McpServerCard key={server.id} server={server} onChanged={() => void reload()} />
          ))
        )}
      </div>

      <ConnectMcpDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={() => {
          setConnectOpen(false);
          void reload();
        }}
      />
    </section>
  );
}
