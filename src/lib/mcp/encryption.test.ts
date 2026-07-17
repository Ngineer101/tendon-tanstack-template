import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "#/lib/mcp/encryption";

const TEST_KEY = "test-encryption-key-32-bytes!!";

describe("encrypt and decrypt", () => {
  it("encrypts a string and decrypts it back", async () => {
    const plaintext = "my-secret-token-value";
    const encrypted = await encrypt(plaintext, TEST_KEY);
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toBe(plaintext);

    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext", async () => {
    const e1 = await encrypt("hello", TEST_KEY);
    const e2 = await encrypt("hello", TEST_KEY);
    expect(e1).not.toBe(e2);
  });

  it("handles JSON payloads", async () => {
    const payload = JSON.stringify({
      accessToken: "abc123",
      refreshToken: "ref456",
      expiresIn: 3600,
    });
    const encrypted = await encrypt(payload, TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(JSON.parse(decrypted)).toEqual({
      accessToken: "abc123",
      refreshToken: "ref456",
      expiresIn: 3600,
    });
  });

  it("fails to decrypt with a different key", async () => {
    const encrypted = await encrypt("sensitive data", TEST_KEY);
    await expect(decrypt(encrypted, "different-key-32-bytes-long!")).rejects.toThrow();
  });

  it("handles empty strings", async () => {
    const encrypted = await encrypt("", TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe("");
  });

  it("handles unicode strings", async () => {
    const plaintext = "token-with-unicode-\u00e9-\u263a";
    const encrypted = await encrypt(plaintext, TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });
});
