/**
 * Symmetric encryption of MCP OAuth secrets at rest, using WebCrypto AES-GCM.
 *
 * The key is provided by the caller from the `MCP_ENCRYPTION_KEY` secret
 * (base64url, 32 bytes). It is never logged.
 *
 * Ciphertext layout (base64url): `iv(12).ciphertext+tag` — where `.` is a
 * literal separator and the 16-byte GCM tag is appended by WebCrypto.
 */
import { ApiError } from "#/lib/api-error";

const IV_BYTES = 12;
const KEY_BYTES = 32;

export type McpEncryptionKey = CryptoKey;

function base64urlToBytes(b64: string): Uint8Array {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? s : s + "=".repeat(4 - (s.length % 4));
  const binary = atob(pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function importEncryptionKey(rawKey: string): Promise<McpEncryptionKey> {
  if (!rawKey) throw new ApiError(500, "MCP encryption key is not configured");
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64urlToBytes(rawKey);
  } catch {
    throw new ApiError(500, "MCP encryption key is malformed");
  }
  if (keyBytes.length !== KEY_BYTES) {
    throw new ApiError(500, "MCP encryption key must be 32 bytes");
  }
  return crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(key: McpEncryptionKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext,
  );
  return `${bytesToBase64url(iv)}.${bytesToBase64url(new Uint8Array(cipher))}`;
}

export async function decryptJson<T = unknown>(key: McpEncryptionKey, blob: string): Promise<T> {
  const [ivPart, cipherPart] = blob.split(".");
  if (!ivPart || !cipherPart) {
    throw new ApiError(500, "Stored MCP credentials are corrupt");
  }
  const iv = base64urlToBytes(ivPart);
  const cipher = base64urlToBytes(cipherPart);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      cipher as BufferSource,
    );
  } catch {
    // Tampered ciphertext, wrong key, or rotated key without re-encryption.
    throw new ApiError(500, "Unable to decrypt stored MCP credentials");
  }
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/**
 * Test helper: derive the same CryptoKey shape from raw bytes so tests don't
 * need to round-trip base64.
 */
export async function importKeyFromBytes(bytes: Uint8Array): Promise<McpEncryptionKey> {
  if (bytes.length !== KEY_BYTES) throw new Error("key must be 32 bytes");
  return crypto.subtle.importKey("raw", bytes as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
