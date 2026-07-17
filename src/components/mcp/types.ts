/**
 * Client-side types mirroring the MCP API responses. Server-only types live in
 * `lib/mcp/*`; these are the safe projections returned to the browser.
 */

export type McpServerStatus = "pending" | "active" | "error" | "disconnected";

export interface McpResourceMeta {
  resource?: string;
  authorization_servers?: string[];
  name?: string;
  description?: string;
  icon_uri?: string;
  bearer_methods_supported?: string[];
}

export interface McpServerView {
  id: string;
  name: string;
  serverUrl: string;
  status: McpServerStatus;
  resource: McpResourceMeta;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpServersResponse {
  servers: McpServerView[];
  plan: "free" | "pro_monthly";
  limit: number | null;
  remaining: number | null;
}

export interface McpConnectResponse {
  server: McpServerView;
  authorizationUrl: string;
  redirectUri: string;
}

export interface McpTestResponse {
  ok: boolean;
  message: string;
  status: number;
}

export interface ApiErrorBody {
  error?: string;
  limit?: number;
}

export const STATUS_META: Record<McpServerStatus, { label: string; tone: string; dot: string }> = {
  pending: {
    label: "Pending",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  active: {
    label: "Connected",
    tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  error: {
    label: "Needs attention",
    tone: "border-destructive/30 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
  disconnected: {
    label: "Disconnected",
    tone: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
  },
};
