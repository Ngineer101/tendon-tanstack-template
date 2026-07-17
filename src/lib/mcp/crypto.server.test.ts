import { describe, expect, it } from "vitest";

import { decryptJson, encryptJson } from "./crypto.server";

const KEY_A = Buffer.from("a".repeat(32)).toString("base64");
const KEY_B = Buffer.from("b".repeat(32)).toString("base64");

function envWith(key: string) {
  return { MCP_ENCRYPTION_KEY: key };
}

describe("mcp crypto", () => {
  it("round-trips JSON payloads", async () => {
    const payload = {
      accessToken: "secret-token-value",
      refreshToken: "refresh-token-value",
      nested: { clientId: "client-123" },
    };
    const encrypted = await encryptJson(envWith(KEY_A), payload);
    const decrypted = await decryptJson(envWith(KEY_A), encrypted);
    expect(decrypted).toEqual(payload);
  });

  it("produces versioned, non-repeating ciphertext that never contains plaintext", async () => {
    const token = "super-secret-access-token-12345";
    const first = await encryptJson(envWith(KEY_A), { token });
    const second = await encryptJson(envWith(KEY_A), { token });

    expect(first).not.toEqual(second); // random IV per encryption
    expect(first.startsWith("v1.")).toBe(true);
    expect(first).not.toContain(token);
    expect(first).not.toContain(Buffer.from(token).toString("base64"));
  });

  it("refuses to decrypt with the wrong key", async () => {
    const encrypted = await encryptJson(envWith(KEY_A), { token: "abc" });
    await expect(decryptJson(envWith(KEY_B), encrypted)).rejects.toThrow(
      "Unable to decrypt payload",
    );
  });

  it("detects tampered ciphertext", async () => {
    const encrypted = await encryptJson(envWith(KEY_A), { token: "abc" });
    const [version, iv, data] = encrypted.split(".");
    const tampered = [version, iv, `${data.slice(0, -4)}AAAA`].join(".");
    await expect(decryptJson(envWith(KEY_A), tampered)).rejects.toThrow(
      "Unable to decrypt payload",
    );
  });

  it("rejects malformed payloads", async () => {
    await expect(decryptJson(envWith(KEY_A), "not-encrypted")).rejects.toThrow(
      "Malformed encrypted payload",
    );
    await expect(decryptJson(envWith(KEY_A), "v2.abc.def")).rejects.toThrow(
      "Malformed encrypted payload",
    );
  });

  it("fails clearly when the key is missing or malformed", async () => {
    await expect(encryptJson(envWith(""), { a: 1 })).rejects.toThrow("MCP_ENCRYPTION_KEY");
    await expect(
      encryptJson(envWith(Buffer.from("short").toString("base64")), { a: 1 }),
    ).rejects.toThrow("32 bytes");
  });
});
