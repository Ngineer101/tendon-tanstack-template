import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import { cipher } from "#/lib/mcp/crypto.server";

const KEY = (() => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytes.buffer;
})();

const WRONG_KEY = (() => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytes.buffer;
})();

describe("cipher", () => {
  it("round-trips a JSON-serialisable payload", async () => {
    const payload = { accessToken: "secret-token", expiresIn: 3600, nested: { a: [1, 2, 3] } };
    const encrypted = await cipher.encrypt(payload, KEY);
    const decrypted = await cipher.decrypt<typeof payload>(encrypted, KEY);
    expect(decrypted).toEqual(payload);
  });

  it("produces a base64url-encoded string that never contains the plaintext", async () => {
    const encrypted = await cipher.encrypt(
      { accessToken: "plaintext-visible-should-not-leak" },
      KEY,
    );
    expect(typeof encrypted).toBe("string");
    expect(encrypted).not.toContain("plaintext-visible-should-not-leak");
    expect(/^[A-Za-z0-9_-]+$/.test(encrypted)).toBe(true);
  });

  it("the IV is random: encrypting twice yields different ciphertext", async () => {
    const a = await cipher.encrypt({ x: 1 }, KEY);
    const b = await cipher.encrypt({ x: 1 }, KEY);
    expect(a).not.toBe(b);
    // Both still decrypt to the same payload.
    expect(await cipher.decrypt(a, KEY)).toEqual({ x: 1 });
    expect(await cipher.decrypt(b, KEY)).toEqual({ x: 1 });
  });

  it("fails to decrypt with the wrong key (authentication tag mismatch)", async () => {
    const encrypted = await cipher.encrypt({ accessToken: "tok" }, KEY);
    await expect(cipher.decrypt(encrypted, WRONG_KEY)).rejects.toThrow();
  });

  it("fails to decrypt a tampered ciphertext", async () => {
    const encrypted = await cipher.encrypt({ accessToken: "tok" }, KEY);
    const tampered = encrypted.slice(0, -2) + (encrypted.endsWith("A") ? "B" : "A");
    await expect(cipher.decrypt(tampered, KEY)).rejects.toThrow();
  });

  it("rejects missing or too-short blobs", async () => {
    await expect(cipher.decrypt("", KEY)).rejects.toBeInstanceOf(ApiError);
    await expect(cipher.decrypt("AAAA", KEY)).rejects.toBeInstanceOf(ApiError);
  });
});
