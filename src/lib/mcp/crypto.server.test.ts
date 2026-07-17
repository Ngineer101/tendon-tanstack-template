import { describe, expect, it } from "vitest";

import { decryptJson, encryptJson, McpCryptoConfigError } from "./crypto.server";
import { TEST_ENCRYPTION_KEY } from "./test-helpers";

describe("mcp crypto", () => {
  it("round-trips JSON payloads", async () => {
    const payload = { accessToken: "tok-123", nested: { refreshToken: "ref-456" } };
    const blob = await encryptJson(TEST_ENCRYPTION_KEY, payload);
    expect(blob.startsWith("v1.")).toBe(true);
    expect(blob).not.toContain("tok-123");
    await expect(decryptJson(TEST_ENCRYPTION_KEY, blob)).resolves.toEqual(payload);
  });

  it("uses a fresh IV for every encryption", async () => {
    const a = await encryptJson(TEST_ENCRYPTION_KEY, { v: 1 });
    const b = await encryptJson(TEST_ENCRYPTION_KEY, { v: 1 });
    expect(a).not.toEqual(b);
  });

  it("rejects tampered ciphertext", async () => {
    const blob = await encryptJson(TEST_ENCRYPTION_KEY, { secret: true });
    const parts = blob.split(".");
    const corrupted = Buffer.from(parts[2], "base64");
    corrupted[0] = corrupted[0] ^ 0xff;
    const tampered = `${parts[0]}.${parts[1]}.${corrupted.toString("base64")}`;
    await expect(decryptJson(TEST_ENCRYPTION_KEY, tampered)).rejects.toThrow();
  });

  it("rejects decryption with a different key", async () => {
    const otherKey = Buffer.alloc(32, 9).toString("base64");
    const blob = await encryptJson(TEST_ENCRYPTION_KEY, { secret: true });
    await expect(decryptJson(otherKey, blob)).rejects.toThrow();
  });

  it("rejects keys that are not 32 bytes", async () => {
    const shortKey = Buffer.alloc(16, 1).toString("base64");
    await expect(encryptJson(shortKey, {})).rejects.toThrow(McpCryptoConfigError);
  });

  it("rejects keys that are not valid base64", async () => {
    await expect(encryptJson("not-valid-base64!!!", {})).rejects.toThrow(McpCryptoConfigError);
  });

  it("rejects unknown payload formats", async () => {
    await expect(decryptJson(TEST_ENCRYPTION_KEY, "v2.abc.def")).rejects.toThrow(
      "Unsupported encrypted payload format",
    );
  });
});
