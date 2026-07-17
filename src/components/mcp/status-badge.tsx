import type { McpServerStatus } from "#/lib/mcp/config";
import { cn } from "#/lib/utils";

const STATUS_PRESENTATION: Record<
  McpServerStatus,
  { label: string; className: string; dotClassName: string; pulse: boolean }
> = {
  connected: {
    label: "Connected",
    className: "border-primary/30 bg-primary/10 text-primary",
    dotClassName: "bg-primary",
    pulse: false,
  },
  pending_auth: {
    label: "Authorization needed",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    dotClassName: "bg-amber-500",
    pulse: true,
  },
  reconnect_required: {
    label: "Reconnect needed",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    dotClassName: "bg-amber-500",
    pulse: true,
  },
  error: {
    label: "Connection error",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
    dotClassName: "bg-destructive",
    pulse: false,
  },
};

export function McpStatusBadge({ status }: { status: McpServerStatus }) {
  const presentation = STATUS_PRESENTATION[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 border px-2 py-0.5 text-xs font-medium transition-colors",
        presentation.className,
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          presentation.dotClassName,
          presentation.pulse && "motion-safe:animate-pulse",
        )}
      />
      {presentation.label}
    </span>
  );
}
