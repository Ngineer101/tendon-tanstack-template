import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { FREE_SERVER_LIMIT } from "#/lib/mcp/config.server";
import {
  assertCanConnectServer,
  decideConnection,
  McpLimitError,
} from "#/lib/mcp/entitlements.server";

describe("MCP entitlements / 3-server limit", () => {
  it("FREE_SERVER_LIMIT is exactly 3", () => {
    expect(FREE_SERVER_LIMIT).toBe(3);
  });

  it("free users can connect up to the limit", () => {
    expect(decideConnection("free", 0)).toEqual({
      canConnect: true,
      limit: 3,
      remaining: 3,
    });
    expect(decideConnection("free", 2)).toEqual({
      canConnect: true,
      limit: 3,
      remaining: 1,
    });
  });

  it("blocks a free user at the limit (the 4th connection)", () => {
    const decision = decideConnection("free", 3);
    expect(decision.canConnect).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  it("pro users get unlimited connections", () => {
    expect(decideConnection("pro_monthly", 0)).toEqual({
      canConnect: true,
      limit: null,
      remaining: null,
    });
    expect(decideConnection("pro_monthly", 1_000_000).canConnect).toBe(true);
  });

  it("assertCanConnectServer throws McpLimitError (402) at the limit", () => {
    expect(() => assertCanConnectServer("free", 3)).toThrow(McpLimitError);
    try {
      assertCanConnectServer("free", 3);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.status).toBe(402);
      if (!(err instanceof McpLimitError)) throw err;
      expect(err.limit).toBe(3);
    }
  });

  it("assertCanConnectServer allows pro users past the limit", () => {
    expect(() => assertCanConnectServer("pro_monthly", 9999)).not.toThrow();
  });

  it("treats negative counts defensively as zero", () => {
    expect(decideConnection("free", -5).remaining).toBe(3);
  });
});
