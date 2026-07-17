// Tests for at-rest encryption of MCP OAuth credentials.
//
// These cover the round-trip (encrypt then decrypt), key validation, and the
// envelope shape — all of which are critical because credentials must never be
// readable from the database or logs without the env-managed key.

import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import {
  decryptSecret,
  encodeBase64,
  encryptSecret,
  generateEncryptionKey,
} from "#/lib/mcp/crypto.server";
import type { McpEnv } from "#/lib/mcp/config.server";

function keyEnv(key: string = generateEncryptionKey()): McpEnv {
  return {
    DB: {} as D1Database,
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "secret",
    MCP_ENCRYPTION_KEY: key,
  } as unknown as McpEnv;
}

describe("generateEncryptionKey", () => {
  it("returns base64 of 32 random bytes", () => {
    const key = generateEncryptionKey();
    const bytes = Buffer.from(key, "base64");
    expect(bytes.byteLength).toBe(32);
  });

  it("produces different keys on each call", () => {
    expect(generateEncryptionKey()).not.toBe(generateEncryptionKey());
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips an arbitrary JSON payload", async () => {
    const env = keyEnv();
    const payload = {
      accessToken: "access-token-value",
      refreshToken: "refresh-token-value",
      expiresAt: 1234567890,
      clientId: "client-1",
    };
    const stored = await encryptSecret(env, payload);
    expect(typeof stored).toBe("string");

    // The encrypted blob must never contain the plaintext token.
    expect(stored).not.toContain("access-token-value");

    const decoded = await decryptSecret(env, stored);
    expect(decoded).toEqual(payload);
  });

  it("produces a different ciphertext for the same plaintext (random IV)", async () => {
    const env = keyEnv();
    const payload = { accessToken: "abc" };
    const a = await encryptSecret(env, payload);
    const b = await encryptSecret(env, payload);
    expect(a).not.toBe(b);
    // But both decrypt to the same value.
    expect(await decryptSecret(env, a)).toEqual(payload);
    expect(await decryptSecret(env, b)).toEqual(payload);
  });

  it("stores an envelope with iv and data fields as base64", async () => {
    const env = keyEnv();
    const stored = await encryptSecret(env, { accessToken: "x" });
    const blob = JSON.parse(stored) as { iv: string; data: string };
    expect(typeof blob.iv).toBe("string");
    expect(typeof blob.data).toBe("string");
    // IV is 12 bytes base64-encoded.
    expect(Buffer.from(blob.iv, "base64").byteLength).toBe(12);
  });

  it("fails decryption with a different key", async () => {
    const envA = keyEnv();
    const envB = keyEnv(generateEncryptionKey());
    const stored = await encryptSecret(envA, { accessToken: "secret" });
    await expect(decryptSecret(envB, stored)).rejects.toThrow();
  });

  it("throws an ApiError when the key is missing", async () => {
    const env = {
      DB: {} as D1Database,
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "secret",
    } as unknown as McpEnv;
    await expect(encryptSecret(env, { a: 1 })).rejects.toThrow(ApiError);
    await expect(decryptSecret(env, "garbage")).rejects.toThrow(ApiError);
  });

  it("throws an ApiError when the key is the wrong length", async () => {
    const env = keyEnv(encodeBase64(new Uint8Array(16)));
    await expect(encryptSecret(env, { a: 1 })).rejects.toThrow(ApiError);
  });

  it("throws an ApiError when decrypting corrupt envelopes", async () => {
    const env = keyEnv();
    await expect(decryptSecret(env, "not-json")).rejects.toThrow(ApiError);
    await expect(decryptSecret(env, JSON.stringify({ iv: "x", data: "y" }))).rejects.toThrow(
      ApiError,
    );
  });
});
