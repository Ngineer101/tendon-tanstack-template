import { getEncryptionSecret, type McpEnv } from "./config.server";

/**
 * Authenticated encryption for MCP credentials at rest.
 *
 * Format: `v1.<base64url(iv)>.<base64url(ciphertext || gcm-tag)>`
 * Key: SHA-256 of the MCP_ENCRYPTION_KEY secret, imported as an AES-GCM key.
 * Uses WebCrypto only, so it runs in both Cloudflare Workers and Node tests.
 */

const FORMAT_VERSION = "v1";
const IV_LENGTH_BYTES = 12;

// Memoized key imports keyed by secret value. CryptoKeys are immutable
// handles, not user data, so caching them across requests is safe.
const keyCache = new Map<string, Promise<CryptoKey>>();

async function getKey(env: McpEnv): Promise<CryptoKey> {
  const secret = getEncryptionSecret(env);
  let cached = keyCache.get(secret);
  if (!cached) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    cached = crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    keyCache.set(secret, cached);
  }
  return cached;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encryptJson(env: McpEnv, value: unknown): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return `${FORMAT_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptJson<T>(env: McpEnv, payload: string): Promise<T> {
  const [version, ivPart, dataPart] = payload.split(".");
  if (version !== FORMAT_VERSION || !ivPart || !dataPart) {
    throw new Error("Unsupported encrypted payload format");
  }

  const key = await getKey(env);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivPart) as BufferSource },
      key,
      fromBase64Url(dataPart) as BufferSource,
    );
  } catch {
    // GCM tag mismatch: wrong key or tampered ciphertext. Never leak details.
    throw new Error("Unable to decrypt stored MCP credentials");
  }

  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
