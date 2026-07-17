import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { decryptJson, encryptJson, importEncryptionKey } from "./crypto.server";
import { TEST_ENCRYPTION_KEY } from "./test-utils";

describe("mcp crypto", () => {
  it("round-trips JSON payloads", async () => {
    const key = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    const payload = { accessToken: "secret-token", nested: { n: 1 } };
    const encrypted = await encryptJson(key, payload);

    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain("secret-token");
    await expect(decryptJson(key, encrypted)).resolves.toEqual(payload);
  });

  it("produces unique ciphertexts for identical payloads", async () => {
    const key = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    const first = await encryptJson(key, { a: 1 });
    const second = await encryptJson(key, { a: 1 });
    expect(first).not.toEqual(second);
  });

  it("rejects tampered ciphertext", async () => {
    const key = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    const encrypted = await encryptJson(key, { a: 1 });
    const [version, iv, ciphertext] = encrypted.split(".");
    const tampered = `${version}.${iv}.${ciphertext.slice(0, -4)}AAAA`;

    await expect(decryptJson(key, tampered)).rejects.toThrow("Unable to decrypt");
  });

  it("rejects ciphertext encrypted with a different key", async () => {
    const keyA = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    const keyB = await importEncryptionKey(Buffer.alloc(32, 9).toString("base64"));
    const encrypted = await encryptJson(keyA, { a: 1 });

    await expect(decryptJson(keyB, encrypted)).rejects.toThrow("Unable to decrypt");
  });

  it("fails with a 500 when the key is missing or malformed", async () => {
    await expect(importEncryptionKey(undefined)).rejects.toMatchObject({ status: 500 });
    await expect(importEncryptionKey("not-base64!!")).rejects.toBeInstanceOf(ApiError);
    await expect(importEncryptionKey(Buffer.alloc(16, 1).toString("base64"))).rejects.toMatchObject(
      { status: 500 },
    );
  });

  it("rejects unsupported payload formats", async () => {
    const key = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    await expect(decryptJson(key, "v2.abc.def")).rejects.toMatchObject({ status: 500 });
    await expect(decryptJson(key, "garbage")).rejects.toBeInstanceOf(ApiError);
  });
});
