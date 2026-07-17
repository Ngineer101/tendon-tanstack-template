import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ApiError } from "#/lib/api-error";
import {
  getValidatedRequestOrigin,
  handleApiError,
  parseJsonBody,
  requireAuthenticatedSession,
} from "./api-guards";

describe("API authorization guards", () => {
  it("rejects missing sessions without exposing account details", () => {
    expect(() => requireAuthenticatedSession(null)).toThrowError(ApiError);
    try {
      requireAuthenticatedSession(null);
    } catch (error) {
      expect(error).toMatchObject({ status: 401, message: "Unauthorized" });
    }
  });

  it("returns an authenticated session", () => {
    const session = { user: { id: "user_1" } };
    expect(requireAuthenticatedSession(session)).toBe(session);
  });

  it("requires an exact same-origin header for mutations", () => {
    expect(
      getValidatedRequestOrigin(
        "https://app.example.com/api/mcp/servers",
        "https://app.example.com",
        true,
      ),
    ).toBe("https://app.example.com");
    expect(() =>
      getValidatedRequestOrigin(
        "https://app.example.com/api/mcp/servers",
        "https://attacker.example",
        true,
      ),
    ).toThrowError(/Invalid origin/);
    expect(() =>
      getValidatedRequestOrigin("https://app.example.com/api/mcp/servers", null, true),
    ).toThrowError(/Invalid origin/);
  });
});

describe("API request errors", () => {
  const schema = z.object({ serverUrl: z.string().url() });

  it("rejects non-JSON and malformed JSON bodies with client errors", async () => {
    await expect(
      parseJsonBody(
        new Request("https://app.example/api", { method: "POST", body: "text" }),
        schema,
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      parseJsonBody(
        new Request("https://app.example/api", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        schema,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns a validation error without echoing submitted values", async () => {
    const secretValue = "not-a-url-with-secret-data";
    await expect(
      parseJsonBody(
        new Request("https://app.example/api", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ serverUrl: secretValue }),
        }),
        schema,
      ),
    ).rejects.toSatisfy(
      (error: ApiError) => error.status === 400 && !error.message.includes(secretValue),
    );
  });

  it("rejects oversized request bodies", async () => {
    await expect(
      parseJsonBody(
        new Request("https://app.example/api", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ serverUrl: `https://example.com/${"x".repeat(9_000)}` }),
        }),
        schema,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("preserves curated API errors and hides unexpected error messages from responses and logs", async () => {
    const curated = handleApiError(new ApiError(402, "Plan limit reached", { limit: 3 }));
    expect(curated.status).toBe(402);
    await expect(curated.json()).resolves.toEqual({ error: "Plan limit reached", limit: 3 });

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = "access-token-that-must-not-appear";
    const unexpected = handleApiError(new Error(secret));
    expect(unexpected.status).toBe(500);
    const body = (await unexpected.json()) as { error: string; errorId: string };
    expect(body.error).toBe("Unable to complete request");
    expect(body.errorId).toBeTruthy();
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    log.mockRestore();
  });
});
