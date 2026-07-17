import { describe, expect, it } from "vitest";

import { decryptJson, encryptJson } from "./crypto.server";
import { TEST_ENCRYPTION_KEY } from "./testing/d1-shim";

const env = { MCP_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } as never;

describe("encryptJson / decryptJson", () => {
  it("round-trips JSON values", async () => {
    const value = { accessToken: "secret-token", nested: { a: [1, 2, 3] }, n: 42 };
    const encrypted = await encryptJson(env, value);
    expect(await decryptJson(env, encrypted)).toEqual(value);
  });

  it("produces versioned, non-deterministic ciphertext that never contains plaintext", async () => {
    const first = await encryptJson(env, { token: "super-secret-value" });
    const second = await encryptJson(env, { token: "super-secret-value" });
    expect(first.startsWith("v1.")).toBe(true);
    expect(first).not.toBe(second);
    expect(first).not.toContain("super-secret-value");
  });

  it("rejects tampered ciphertext (AES-GCM authentication)", async () => {
    const encrypted = await encryptJson(env, { token: "abc" });
    const [version, iv, data] = encrypted.split(".");
    const tampered = `${version}.${iv}.${data.slice(0, -4)}AAAA`;
    await expect(decryptJson(env, tampered)).rejects.toThrow(/decrypted/);
  });

  it("fails with a wrong key", async () => {
    const encrypted = await encryptJson(env, { token: "abc" });
    const otherKey = Buffer.from("fedcba9876543210fedcba9876543210", "utf8").toString("base64");
    await expect(decryptJson({ MCP_ENCRYPTION_KEY: otherKey } as never, encrypted)).rejects.toThrow(
      /decrypted/,
    );
  });

  it("fails cleanly when the key is missing or malformed", async () => {
    await expect(encryptJson({ MCP_ENCRYPTION_KEY: "" } as never, {})).rejects.toThrow(
      /not configured/,
    );
    await expect(encryptJson({ MCP_ENCRYPTION_KEY: "c2hvcnQ=" } as never, {})).rejects.toThrow(
      /32 bytes/,
    );
    await expect(decryptJson(env, "garbage")).rejects.toThrow(/unknown format/);
  });
});
