import { describe, expect, it } from "vitest";

import { decryptJson, encryptJson, sha256Base64Url } from "./crypto.server";

const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("MCP credential encryption", () => {
  it("round-trips encrypted credentials without storing plaintext", async () => {
    const credentials = { accessToken: "sensitive-token", refreshToken: "refresh-token" };
    const encrypted = await encryptJson(credentials, TEST_KEY, "user:connection");

    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("sensitive-token");
    await expect(decryptJson(encrypted, TEST_KEY, "user:connection")).resolves.toEqual(credentials);
  });

  it("rejects ciphertext moved to another user or connection", async () => {
    const encrypted = await encryptJson({ accessToken: "token" }, TEST_KEY, "user-a:server-a");
    await expect(decryptJson(encrypted, TEST_KEY, "user-b:server-a")).rejects.toThrow("unreadable");
  });

  it("creates stable, URL-safe state digests", async () => {
    const first = await sha256Base64Url("oauth-state");
    const second = await sha256Base64Url("oauth-state");
    expect(first).toBe(second);
    expect(first).toMatch(/^[\w-]+$/);
  });
});
