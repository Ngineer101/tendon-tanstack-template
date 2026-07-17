import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api-error";
import { handleApiError, readJsonBody } from "./api-utils";

afterEach(() => vi.restoreAllMocks());

describe("API errors", () => {
  it("serializes safe domain details", async () => {
    const response = handleApiError(new ApiError(409, "Reconnect required", { code: "reconnect" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Reconnect required",
      code: "reconnect",
    });
  });

  it("does not leak unexpected errors to the client", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = handleApiError(new Error("database password leaked"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Unable to complete request" });
  });

  it("rejects oversized JSON request bodies", async () => {
    const request = new Request("https://app.example.net/api", {
      method: "POST",
      headers: { "content-length": "20000" },
      body: "{}",
    });
    await expect(readJsonBody(request)).rejects.toMatchObject({ status: 413 });
  });
});
