import { describe, expect, it } from "vitest";

import type { McpEnv } from "./config.server";
import { decryptJson, encryptJson } from "./crypto.server";

const env = {
  MCP_ENCRYPTION_KEY: "test-encryption-key-with-plenty-of-entropy",
} as McpEnv;

const otherEnv = {
  MCP_ENCRYPTION_KEY: "a-different-encryption-key-entirely",
} as McpEnv;

describe("encryptJson / decryptJson", () => {
  it("round-trips arbitrary JSON payloads", async () => {
    const payload = {
      accessToken: "access-token-123",
      refreshToken: "refresh-token-456",
      expiresAt: 1_900_000_000_000,
      scope: "read write",
      tokenType: "Bearer",
    };

    const encrypted = await encryptJson(env, payload);
    expect(encrypted).not.toContain("access-token-123");
    expect(encrypted).not.toContain("refresh-token-456");

    const decrypted = await decryptJson(env, encrypted);
    expect(decrypted).toEqual(payload);
  });

  it("produces versioned v1.iv.ciphertext payloads with unique IVs", async () => {
    const first = await encryptJson(env, { token: "same-input" });
    const second = await encryptJson(env, { token: "same-input" });

    expect(first).toMatch(/^v1\./);
    // Random IVs mean identical plaintext never yields identical ciphertext.
    expect(first).not.toEqual(second);
  });

  it("fails to decrypt with a different key", async () => {
    const encrypted = await encryptJson(env, { token: "secret" });
    await expect(decryptJson(otherEnv, encrypted)).rejects.toThrow(
      "Unable to decrypt stored MCP credentials",
    );
  });

  it("fails to decrypt tampered ciphertext", async () => {
    const encrypted = await encryptJson(env, { token: "secret" });
    const [version, iv, data] = encrypted.split(".");
    const tampered = `${version}.${iv}.${data.slice(0, -4)}AAAA`;

    await expect(decryptJson(env, tampered)).rejects.toThrow(
      "Unable to decrypt stored MCP credentials",
    );
  });

  it("rejects payloads in an unsupported format", async () => {
    await expect(decryptJson(env, "not-encrypted")).rejects.toThrow(
      "Unsupported encrypted payload format",
    );
    await expect(decryptJson(env, "v0.abc.def")).rejects.toThrow(
      "Unsupported encrypted payload format",
    );
  });

  it("fails closed when the encryption key is missing or weak", async () => {
    await expect(encryptJson({ MCP_ENCRYPTION_KEY: "" } as McpEnv, { token: "x" })).rejects.toThrow(
      "MCP_ENCRYPTION_KEY",
    );
    await expect(
      encryptJson({ MCP_ENCRYPTION_KEY: "short" } as McpEnv, { token: "x" }),
    ).rejects.toThrow("MCP_ENCRYPTION_KEY");
  });
});
