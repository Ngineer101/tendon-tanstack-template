// At-rest encryption for MCP OAuth credentials.
//
// Uses the Web Crypto API (AES-GCM 256) with the env-managed
// `MCP_ENCRYPTION_KEY`. The key is a base64-encoded 32-byte raw key. We store
// an envelope `{ iv, ciphertext }` as base64 in the database. Keys are never
// logged and never returned to the client.

import { ApiError } from "#/lib/api-error";
import { type McpEnv } from "./config.server";

// 96-bit IV is the recommended size for AES-GCM.
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export interface EncryptedBlob {
  iv: string; // base64
  data: string; // base64 ciphertext
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Copy a Uint8Array into a fresh ArrayBuffer-backed buffer so TypeScript's DOM
// lib is satisfied that it is a `BufferSource` (not a SharedArrayBuffer view).
function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encryptionKeyBytes(env: McpEnv): Uint8Array {
  const raw = env.MCP_ENCRYPTION_KEY;
  if (!raw) {
    throw new ApiError(500, "MCP encryption is not configured");
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(raw);
  } catch {
    throw new ApiError(500, "MCP encryption key is malformed");
  }
  if (bytes.length !== KEY_LENGTH) {
    throw new ApiError(500, "MCP encryption key must be 32 bytes");
  }
  return bytes;
}

async function getCryptoKey(env: McpEnv): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buffer(encryptionKeyBytes(env)), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(env: McpEnv, plaintext: object): Promise<string> {
  const key = await getCryptoKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const data = new TextEncoder().encode(JSON.stringify(plaintext));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv) }, key, data);
  const blob: EncryptedBlob = {
    iv: encodeBase64(iv),
    data: encodeBase64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(blob);
}

export async function decryptSecret<T = unknown>(env: McpEnv, stored: string): Promise<T> {
  let blob: EncryptedBlob;
  try {
    blob = JSON.parse(stored) as EncryptedBlob;
  } catch {
    throw new ApiError(500, "Encrypted credentials are corrupt");
  }
  if (!blob.iv || !blob.data) {
    throw new ApiError(500, "Encrypted credentials are corrupt");
  }
  const key = await getCryptoKey(env);
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = decodeBase64(blob.iv);
    ciphertext = decodeBase64(blob.data);
  } catch {
    throw new ApiError(500, "Encrypted credentials are corrupt");
  }
  if (iv.length !== IV_LENGTH) {
    throw new ApiError(500, "Encrypted credentials are corrupt");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buffer(iv) },
    key,
    buffer(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

// Generate a base64-encoded 32-byte key for operator setup.
export function generateEncryptionKey(): string {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(KEY_LENGTH)));
}
