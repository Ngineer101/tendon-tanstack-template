import { ApiError } from "#/lib/api-error";

// AES-GCM authenticated encryption of JSON-serialisable payloads. The 12-byte
// IV is prepended to the ciphertext and the whole blob is base64url-encoded so
// the result is safe to store in a SQLite TEXT column. This module never logs
// payloads; callers must also avoid logging the ciphertext or plaintext.

export interface Cipher {
  encrypt(value: unknown, keyBytes: ArrayBuffer): Promise<string>;
  decrypt<T = unknown>(blob: string, keyBytes: ArrayBuffer): Promise<T>;
}

export const cipher: Cipher = {
  async encrypt(value, keyBytes) {
    const key = await importKey(keyBytes, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.byteLength);
    return base64urlEncode(combined);
  },

  async decrypt<T = unknown>(blob: string, keyBytes: ArrayBuffer): Promise<T> {
    if (!blob) throw new ApiError(500, "Encrypted payload missing");
    const combined = base64urlDecode(blob);
    if (combined.byteLength < 13) throw new ApiError(500, "Encrypted payload corrupt");
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const key = await importKey(keyBytes, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  },
};

async function importKey(keyBytes: ArrayBuffer, usages: KeyUsage[]) {
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, usages);
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
