import type { McpEnv } from "./config.server";

/**
 * AES-256-GCM encryption for MCP auth material at rest.
 *
 * The key is provided exclusively through the `MCP_ENCRYPTION_KEY` environment
 * secret (base64-encoded 32 bytes). Ciphertext format:
 *
 *   v1.<base64url(iv)>.<base64url(ciphertext || authTag)>
 *
 * Uses WebCrypto only, so it runs identically in the Workers runtime and in
 * Node-based unit tests.
 */

const KEY_VERSION = "v1";
const IV_LENGTH_BYTES = 12;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getKey(env: Pick<McpEnv, "MCP_ENCRYPTION_KEY">): Promise<CryptoKey> {
  const raw = env.MCP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("Missing MCP_ENCRYPTION_KEY environment secret");
  }

  let keyBytes: Uint8Array;
  try {
    keyBytes = base64UrlDecode(raw.trim());
  } catch {
    throw new Error("MCP_ENCRYPTION_KEY must be base64-encoded");
  }
  if (keyBytes.length !== 32) {
    throw new Error("MCP_ENCRYPTION_KEY must decode to 32 bytes (AES-256)");
  }

  return crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(
  env: Pick<McpEnv, "MCP_ENCRYPTION_KEY">,
  value: unknown,
): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  return [KEY_VERSION, base64UrlEncode(iv), base64UrlEncode(ciphertext)].join(".");
}

export async function decryptJson<T>(
  env: Pick<McpEnv, "MCP_ENCRYPTION_KEY">,
  payload: string,
): Promise<T> {
  const [version, ivEncoded, dataEncoded] = payload.split(".");
  if (version !== KEY_VERSION || !ivEncoded || !dataEncoded) {
    throw new Error("Malformed encrypted payload");
  }

  const key = await getKey(env);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(ivEncoded) as BufferSource },
      key,
      base64UrlDecode(dataEncoded) as BufferSource,
    );
  } catch {
    throw new Error("Unable to decrypt payload");
  }

  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
