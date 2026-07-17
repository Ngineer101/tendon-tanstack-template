import type { McpServerStatus } from "#/lib/mcp/config";

export interface StatusConfig {
  label: string;
  dotClass: string;
  textClass: string;
  pulse: boolean;
}

export const MCP_STATUS_CONFIG: Record<McpServerStatus, StatusConfig> = {
  connected: {
    label: "Connected",
    dotClass: "bg-emerald-500",
    textClass: "text-emerald-600 dark:text-emerald-400",
    pulse: true,
  },
  pending_auth: {
    label: "Not connected",
    dotClass: "bg-muted-foreground/50",
    textClass: "text-muted-foreground",
    pulse: false,
  },
  needs_auth: {
    label: "Needs re-authentication",
    dotClass: "bg-amber-500",
    textClass: "text-amber-600 dark:text-amber-400",
    pulse: false,
  },
  error: {
    label: "Connection error",
    dotClass: "bg-destructive",
    textClass: "text-destructive",
    pulse: false,
  },
  disconnected: {
    label: "Disconnected",
    dotClass: "bg-muted-foreground/50",
    textClass: "text-muted-foreground",
    pulse: false,
  },
};

export function formatRelativeTime(iso: string | null) {
  if (!iso) return null;
  const elapsed = Date.now() - new Date(iso).getTime();
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
