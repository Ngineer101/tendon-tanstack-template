import { ApiError } from "#/lib/api-error";

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  return crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const ALGORITHM = { name: "AES-GCM" as const, length: 256 };

export async function encrypt(data: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM.name, iv: iv as BufferSource },
    key,
    encoded,
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return bytesToBase64(combined);
}

export async function decrypt(encryptedData: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const combined = base64ToBytes(encryptedData);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM.name, iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(decrypted);
}

export function getEncryptionKey(env: { MCP_ENCRYPTION_KEY: string }): string {
  const key = env.MCP_ENCRYPTION_KEY;
  if (!key) {
    throw new ApiError(500, "MCP encryption key is not configured");
  }
  try {
    const decoded = base64ToBytes(key);
    if (decoded.length !== 32) {
      throw new Error(`Expected 32 bytes, got ${decoded.length}`);
    }
  } catch {
    throw new ApiError(500, "MCP encryption key must be a 32-byte base64-encoded string");
  }
  return key;
}
