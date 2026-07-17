import { ApiError } from "#/lib/api-error";

// AES-256-GCM encryption for MCP credentials at rest. The key comes from the
// MCP_TOKEN_ENCRYPTION_KEY environment secret (base64, 32 bytes), e.g.
// generated with `openssl rand -base64 32`.

const ENCRYPTION_VERSION = "v1";
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function importEncryptionKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) {
    throw new ApiError(500, "MCP encryption is not configured");
  }

  let raw: Uint8Array;
  try {
    raw = fromBase64(secret.trim());
  } catch {
    throw new ApiError(500, "MCP encryption key must be base64 encoded");
  }
  if (raw.length !== KEY_LENGTH_BYTES) {
    throw new ApiError(500, "MCP encryption key must decode to 32 bytes");
  }

  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return `${ENCRYPTION_VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptJson<T>(key: CryptoKey, payload: string): Promise<T> {
  const [version, ivPart, ciphertextPart] = payload.split(".");
  if (version !== ENCRYPTION_VERSION || !ivPart || !ciphertextPart) {
    throw new ApiError(500, "Stored MCP credentials use an unsupported format");
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(ivPart) as BufferSource },
      key,
      fromBase64(ciphertextPart) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    // Deliberately generic: never surface cryptographic details or key material.
    throw new ApiError(500, "Unable to decrypt stored MCP credentials");
  }
}
