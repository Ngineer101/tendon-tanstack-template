import { describe, expect, it } from "vitest";

import { ApiError } from "#/lib/api-error";
import {
  decryptJson,
  encryptJson,
  importEncryptionKey,
  importKeyFromBytes,
} from "#/lib/mcp/crypto.server";

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("MCP crypto", () => {
  it("round-trips a JSON payload", async () => {
    const key = await importKeyFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const payload = { accessToken: "sekret", refreshToken: "r", expiresAt: 123 };
    const blob = await encryptJson(key, payload);
    expect(blob).not.toContain("sekret");
    const recovered = await decryptJson<typeof payload>(key, blob);
    expect(recovered).toEqual(payload);
  });

  it("rejects a forged ciphertext (tamper detection)", async () => {
    const key = await importKeyFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const blob = await encryptJson(key, { accessToken: "sekret" });
    const [iv, cipher] = blob.split(".");
    // Flip a middle ciphertext byte so the GCM tag no longer validates.
    const target = 4;
    const original = cipher[target];
    const replacement = original === "z" ? "y" : "z";
    const tampered = `${iv}.${cipher.slice(0, target)}${replacement}${cipher.slice(target + 1)}`;
    await expect(decryptJson(key, tampered)).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a decrypt with the wrong key", async () => {
    const k1 = await importKeyFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const k2 = await importKeyFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const blob = await encryptJson(k1, { accessToken: "x" });
    await expect(decryptJson(k2, blob)).rejects.toBeInstanceOf(ApiError);
  });

  it("surfaces a 500 when the key is missing", async () => {
    await expect(importEncryptionKey("")).rejects.toBeInstanceOf(ApiError);
  });

  it("surfaces a 500 when the key has the wrong length", async () => {
    await expect(importEncryptionKey(base64url(new Uint8Array(16)))).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("requires the correct base64url-encoded 32-byte key", async () => {
    const key = await importEncryptionKey(base64url(crypto.getRandomValues(new Uint8Array(32))));
    expect(key).toBeDefined();
  });
});
