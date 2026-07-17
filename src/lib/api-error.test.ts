import { describe, expect, it, vi } from "vitest";

import { ApiError, handleApiError, readJsonBody } from "./api-error";

describe("API error responses", () => {
  it("preserves safe domain errors and their status", async () => {
    const response = handleApiError(new ApiError(403, "Connection limit reached", { limit: 3 }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Connection limit reached", limit: 3 });
  });

  it("does not expose unexpected error messages", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = handleApiError(new Error("access_token=secret-value"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret-value");
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("secret-value");
    consoleError.mockRestore();
  });
});

describe("API JSON body validation", () => {
  it("parses bounded JSON requests", async () => {
    const request = new Request("https://app.example.net/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "mcp_1" }),
    });
    await expect(readJsonBody<{ id: string }>(request)).resolves.toEqual({ id: "mcp_1" });
  });

  it("rejects invalid content types and oversized bodies", async () => {
    const textRequest = new Request("https://app.example.net/api", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    await expect(readJsonBody(textRequest)).rejects.toMatchObject({ status: 415 });

    const largeRequest = new Request("https://app.example.net/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(200) }),
    });
    await expect(readJsonBody(largeRequest, 32)).rejects.toMatchObject({ status: 413 });
  });
});
