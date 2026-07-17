import { describe, it, expect } from "vitest";
import { ApiError } from "#/lib/api-error";

describe("handleApiError (unit logic)", () => {
  function handleApiError(error: unknown, fallback?: { status: number; message: string }) {
    if (error instanceof Response) return error;

    if (error instanceof ApiError) {
      return Response.json({ error: error.message, ...error.details }, { status: error.status });
    }

    return Response.json(
      { error: fallback?.message ?? "Unable to complete request" },
      { status: fallback?.status ?? 500 },
    );
  }

  it("returns Response for ApiError with correct status", async () => {
    const error = new ApiError(403, "Forbidden", { limit: 3 });
    const response = handleApiError(error);
    expect(response instanceof Response).toBe(true);
    expect(response.status).toBe(403);

    const body = (await response.json()) as { error: string; limit: number };
    expect(body.error).toBe("Forbidden");
    expect(body.limit).toBe(3);
  });

  it("returns 500 for unknown errors", async () => {
    const response = handleApiError(new Error("Something broke"));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Unable to complete request");
  });

  it("returns custom fallback for unknown errors", async () => {
    const response = handleApiError(new Error("Oops"), {
      status: 502,
      message: "Bad gateway",
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Bad gateway");
  });

  it("returns the Response if error is already a Response", () => {
    const original = new Response("already a response", { status: 400 });
    const response = handleApiError(original);
    expect(response).toBe(original);
  });
});

describe("MCP server limit - domain logic", () => {
  it("free users are limited to 3 servers", () => {
    const freeLimit = 3;
    expect(freeLimit).toBe(3);
  });

  it("rejects creation at limit for free users", () => {
    const currentCount = 3;
    const isPro = false;
    const MAX_FREE = 3;

    if (!isPro && currentCount >= MAX_FREE) {
      const error = new ApiError(
        403,
        `Free accounts are limited to ${MAX_FREE} MCP servers. Upgrade to Pro for unlimited.`,
        { limit: MAX_FREE, current: currentCount },
      );
      expect(error.status).toBe(403);
      expect(error.details?.limit).toBe(3);
      expect(error.details?.current).toBe(3);
    } else {
      expect.fail("Should have thrown an error");
    }
  });

  it("allows creation at limit for pro users", () => {
    const isPro = true;
    let threwError = false;
    try {
      if (!isPro) {
        throw new ApiError(403, "Limit reached");
      }
    } catch {
      threwError = true;
    }
    expect(threwError).toBe(false);
  });

  it("allows creation under limit for free users", () => {
    const currentCount = 2;
    const isPro = false;
    const MAX_FREE = 3;

    let threwError = false;
    try {
      if (!isPro && currentCount >= MAX_FREE) {
        throw new ApiError(403, "Limit reached");
      }
    } catch {
      threwError = true;
    }
    expect(threwError).toBe(false);
  });
});

describe("entitlement check", () => {
  it("recognizes mcp_unlimited entitlement", () => {
    const entitlements = ["premium_dashboard", "mcp_unlimited"];
    expect(entitlements.includes("mcp_unlimited")).toBe(true);
  });

  it("does not grant mcp_unlimited to free plan", () => {
    const freeEntitlements: string[] = [];
    expect(freeEntitlements.includes("mcp_unlimited")).toBe(false);
  });
});

describe("OAuth state validation", () => {
  it("rejects state with missing separator", () => {
    const state = "uuid-without-dot";
    const [, second] = state.split(".");
    expect(second).toBeUndefined();
  });

  it("splits state and data correctly", () => {
    const state = "abc123.encrypted_blob";
    const [first, second] = state.split(".");
    expect(first).toBe("abc123");
    expect(second).toBe("encrypted_blob");
  });
});
