import { ApiError } from "#/lib/api-error";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importKey(encodedKey: string) {
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64UrlDecode(encodedKey);
  } catch {
    throw new ApiError(500, "MCP credential encryption is not configured correctly");
  }

  if (keyBytes.byteLength !== 32) {
    throw new ApiError(500, "MCP credential encryption is not configured correctly");
  }

  return crypto.subtle.importKey("raw", new Uint8Array(keyBytes).buffer, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(value: unknown, encodedKey: string, additionalData: string) {
  const key = await importKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(additionalData), tagLength: 128 },
    key,
    encoder.encode(JSON.stringify(value)),
  );

  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
}

export async function decryptJson<T>(
  value: string,
  encodedKey: string,
  additionalData: string,
): Promise<T> {
  const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext || extra) {
    throw new ApiError(500, "Stored MCP credentials are unreadable");
  }

  try {
    const key = await importKey(encodedKey);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlDecode(encodedIv),
        additionalData: encoder.encode(additionalData),
        tagLength: 128,
      },
      key,
      base64UrlDecode(encodedCiphertext),
    );
    return JSON.parse(decoder.decode(decrypted)) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "Stored MCP credentials are unreadable");
  }
}

export function randomBase64Url(byteLength = 32) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

export function credentialAdditionalData(userId: string, connectionId: string) {
  return `mcp-credentials:v1:${userId}:${connectionId}`;
}

export function oauthAdditionalData(userId: string, connectionId: string) {
  return `mcp-oauth:v1:${userId}:${connectionId}`;
}
