import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret } from "./crypto.server";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

describe("mcp token encryption", () => {
  it("round-trips a secret", async () => {
    const payload = await encryptSecret(KEY, "super-secret-token");
    expect(payload).toMatch(/^v1\./);
    expect(payload).not.toContain("super-secret-token");
    await expect(decryptSecret(KEY, payload)).resolves.toBe("super-secret-token");
  });

  it("produces a different ciphertext per call", async () => {
    const first = await encryptSecret(KEY, "token");
    const second = await encryptSecret(KEY, "token");
    expect(first).not.toBe(second);
  });

  it("fails to decrypt with the wrong key", async () => {
    const payload = await encryptSecret(KEY, "token");
    await expect(decryptSecret(OTHER_KEY, payload)).rejects.toThrow("Unable to decrypt");
  });

  it("fails to decrypt a tampered payload", async () => {
    const payload = await encryptSecret(KEY, "token");
    const [version, iv, ciphertext] = payload.split(".");
    const tampered = ciphertext!.startsWith("A")
      ? `B${ciphertext!.slice(1)}`
      : `A${ciphertext!.slice(1)}`;
    await expect(decryptSecret(KEY, [version, iv, tampered].join("."))).rejects.toThrow();
  });

  it("rejects malformed payloads", async () => {
    await expect(decryptSecret(KEY, "v2.a.b")).rejects.toThrow("Unrecognized");
    await expect(decryptSecret(KEY, "not-a-payload")).rejects.toThrow("Unrecognized");
  });

  it("rejects keys that are not 32 bytes", async () => {
    const shortKey = Buffer.alloc(16, 1).toString("base64");
    await expect(encryptSecret(shortKey, "token")).rejects.toThrow("32 bytes");
    await expect(encryptSecret("!!!not-base64!!!", "token")).rejects.toThrow();
  });
});
