import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "#/lib/mcp/encryption";

const TEST_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function makeEnv() {
  return { MCP_ENCRYPTION_KEY: TEST_KEY };
}

describe("encryption", () => {
  it("encrypts and decrypts a plaintext string", async () => {
    const plaintext = "my-secret-token-data";
    const encrypted = await encrypt(makeEnv(), plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(typeof encrypted).toBe("string");

    const decrypted = await decrypt(makeEnv(), encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypts and decrypts JSON token data", async () => {
    const tokenData = JSON.stringify({
      access_token: "eyJhbGciOiJ...",
      refresh_token: "rt_abc123",
      expires_in: 3600,
    });

    const encrypted = await encrypt(makeEnv(), tokenData);
    const decrypted = await decrypt(makeEnv(), encrypted);
    expect(JSON.parse(decrypted)).toEqual(JSON.parse(tokenData));
  });

  it("produces different ciphertexts for the same input", async () => {
    const plaintext = "same-input";
    const encrypted1 = await encrypt(makeEnv(), plaintext);
    const encrypted2 = await encrypt(makeEnv(), plaintext);
    expect(encrypted1).not.toBe(encrypted2);
  });

  it("throws on invalid encrypted data", async () => {
    await expect(decrypt(makeEnv(), "not-valid-base64!!")).rejects.toThrow();
    await expect(decrypt(makeEnv(), "YQ==")).rejects.toThrow();
  });

  it("throws when decrypting with wrong key", async () => {
    const plaintext = "test-data";
    const encrypted = await encrypt(makeEnv(), plaintext);

    const wrongEnv = {
      MCP_ENCRYPTION_KEY: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    };

    await expect(decrypt(wrongEnv, encrypted)).rejects.toThrow();
  });

  it("throws on invalid key length", async () => {
    const badEnv = { MCP_ENCRYPTION_KEY: "dG9vLXNob3J0" };
    await expect(encrypt(badEnv, "test")).rejects.toThrow(
      "MCP_ENCRYPTION_KEY must be a 32-byte base64-encoded string",
    );
  });
});
