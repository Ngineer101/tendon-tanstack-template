import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "#/lib/mcp/encryption.server";

const TEST_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));

describe("encryption", () => {
  it("encrypts and decrypts data successfully", async () => {
    const data = JSON.stringify({ accessToken: "test-token-123", refreshToken: "refresh-456" });
    const encrypted = await encrypt(data, TEST_KEY);
    expect(encrypted).toBeTruthy();
    expect(typeof encrypted).toBe("string");
    expect(encrypted).not.toBe(data);

    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(data);
  });

  it("produces different ciphertext for same plaintext (different IVs)", async () => {
    const data = "sensitive data";
    const encrypted1 = await encrypt(data, TEST_KEY);
    const encrypted2 = await encrypt(data, TEST_KEY);
    expect(encrypted1).not.toBe(encrypted2);
  });

  it("fails to decrypt with wrong key", async () => {
    const wrongKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, () => 0xff)));
    const encrypted = await encrypt("data", TEST_KEY);
    await expect(decrypt(encrypted, wrongKey)).rejects.toThrow();
  });

  it("fails to decrypt corrupted data", async () => {
    const encrypted = await encrypt("data", TEST_KEY);
    const corrupted = "A" + encrypted.slice(1);
    await expect(decrypt(corrupted, TEST_KEY)).rejects.toThrow();
  });

  it("encrypts empty string", async () => {
    const encrypted = await encrypt("", TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe("");
  });

  it("encrypts unicode data", async () => {
    const data = '{"token": "\uD83D\uDD12"}';
    const encrypted = await encrypt(data, TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(data);
  });
});
