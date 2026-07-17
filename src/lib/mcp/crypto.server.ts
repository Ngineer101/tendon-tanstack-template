import { ApiError } from "#/lib/api-error";
import type { McpEnv } from "./config.server";

const KEY_FORMAT_VERSION = "v1";
const IV_BYTES = 12;

const keyCache = new Map<string, Promise<CryptoKey>>();

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getEncryptionKey(env: McpEnv): Promise<CryptoKey> {
  const raw = env.MCP_ENCRYPTION_KEY;
  if (!raw) {
    throw new ApiError(500, "MCP encryption is not configured");
  }

  let cryptoKey = keyCache.get(raw);
  if (!cryptoKey) {
    let keyBytes: Uint8Array;
    try {
      keyBytes = base64ToBytes(raw);
    } catch {
      throw new ApiError(500, "MCP encryption key is invalid");
    }
    if (keyBytes.length !== 32) {
      throw new ApiError(500, "MCP encryption key must be 32 bytes (base64-encoded)");
    }
    cryptoKey = crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    keyCache.set(raw, cryptoKey);
  }
  return cryptoKey;
}

/**
 * Encrypts a JSON-serializable value with AES-256-GCM. Output format:
 * `v1.<iv>.<ciphertext>` where both segments are base64url. The version
 * prefix allows future key rotation without a schema change.
 */
export async function encryptJson(env: McpEnv, value: unknown): Promise<string> {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return `${KEY_FORMAT_VERSION}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptJson<T>(env: McpEnv, payload: string): Promise<T> {
  const [version, ivSegment, dataSegment] = payload.split(".");
  if (version !== KEY_FORMAT_VERSION || !ivSegment || !dataSegment) {
    throw new ApiError(500, "Stored MCP auth data has an unknown format");
  }

  const key = await getEncryptionKey(env);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(ivSegment) as BufferSource },
      key,
      base64ToBytes(dataSegment) as BufferSource,
    );
  } catch {
    throw new ApiError(500, "Stored MCP auth data could not be decrypted");
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
