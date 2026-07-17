import { AlertCircle, Plus } from "lucide-react";

import { Button } from "#/components/ui/button";
import { McpServerCard } from "./McpServerCard";

interface ServerInfo {
  id: string;
  label: string;
  serverUrl: string;
  authStatus: string;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface McpServerGridProps {
  servers: ServerInfo[];
  loading: boolean;
  error: string | null;
  onConnect: () => void;
  onRefresh: () => void;
}

export function McpServerGrid({
  servers,
  loading,
  error,
  onConnect,
  onRefresh,
}: McpServerGridProps) {
  if (loading && servers.length === 0) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="animate-pulse rounded-lg border bg-card p-6">
            <div className="mb-3 h-4 w-2/3 rounded bg-muted" />
            <div className="mb-2 h-3 w-1/2 rounded bg-muted" />
            <div className="h-7 w-full rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (error && servers.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 border py-12 text-center">
        <AlertCircle className="size-8 text-destructive/60" />
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          Retry
        </Button>
      </div>
    );
  }

  if (!loading && servers.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 border py-12 text-center">
        <p className="text-sm text-muted-foreground">No MCP servers connected yet.</p>
        <Button variant="outline" size="sm" onClick={onConnect}>
          <Plus className="size-4" />
          Connect your first server
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {servers.map((server) => (
        <McpServerCard key={server.id} server={server} onRefresh={onRefresh} />
      ))}
    </div>
  );
}
