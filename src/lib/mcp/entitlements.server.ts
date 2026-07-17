/**
 * MCP server-count entitlements, layered on the existing billing/plan system.
 *
 * Free users may connect at most `FREE_SERVER_LIMIT` MCP servers. Pro users
 * (entitlement `unlimited_mcp_servers`) have unlimited connections.
 *
 * The limit is enforced server-side in `core.server.ts` by counting the user's
 * *active or pending* connections and calling `assertCanConnectServer` before
 * creating a new draft / starting a new OAuth flow.
 */
import { ApiError } from "#/lib/api-error";
import { FREE_SERVER_LIMIT } from "./config.server";
import type { SubscriptionPlan } from "#/lib/billing/config";

export type BillingPlan = "free" | SubscriptionPlan;

export interface EntitlementDecision {
  canConnect: boolean;
  limit: number | null;
  remaining: number | null;
}

/**
 * Decide whether a user on `plan` with `currentCount` existing connections may
 * add another MCP server.
 *
 * `limit` is `null` when unlimited. `remaining` is `null` when unlimited.
 */
export function decideConnection(plan: BillingPlan, currentCount: number): EntitlementDecision {
  const count = Math.max(0, currentCount | 0);
  if (plan === "pro_monthly") {
    return { canConnect: true, limit: null, remaining: null };
  }
  const remaining = Math.max(0, FREE_SERVER_LIMIT - count);
  return { canConnect: count < FREE_SERVER_LIMIT, limit: FREE_SERVER_LIMIT, remaining };
}

export class McpLimitError extends ApiError {
  constructor(public readonly limit: number) {
    super(402, `Free plans can connect at most ${limit} MCP servers`, { limit });
    this.name = "McpLimitError";
  }
}

/**
 * Throws `McpLimitError` (HTTP 402, surfacing an upgrade path) when the user
 * cannot add another MCP server. Used by `createMcpConnection`.
 */
export function assertCanConnectServer(plan: BillingPlan, currentCount: number): void {
  const decision = decideConnection(plan, currentCount);
  if (!decision.canConnect) {
    if (decision.limit === null) throw new Error("Unreachable: limit is null when denied");
    throw new McpLimitError(decision.limit);
  }
}
