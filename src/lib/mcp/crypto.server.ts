// AES-256-GCM encryption for MCP auth material at rest.
// The key comes from the MCP_TOKEN_ENCRYPTION_KEY environment secret
// (base64-encoded 32 bytes, e.g. `openssl rand -base64 32`).

const VERSION = "v1";

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export class McpCryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCryptoConfigError";
  }
}

async function importKey(secret: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64Decode(secret.trim());
  } catch {
    throw new McpCryptoConfigError("MCP_TOKEN_ENCRYPTION_KEY must be valid base64");
  }
  if (raw.length !== 32) {
    throw new McpCryptoConfigError("MCP_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(secret: string, data: unknown): Promise<string> {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext.buffer as ArrayBuffer,
  );
  return `${VERSION}.${base64Encode(iv)}.${base64Encode(new Uint8Array(ciphertext))}`;
}

export async function decryptJson<T>(secret: string, blob: string): Promise<T> {
  const [version, ivPart, dataPart] = blob.split(".");
  if (version !== VERSION || !ivPart || !dataPart) {
    throw new Error("Unsupported encrypted payload format");
  }
  const key = await importKey(secret);
  const iv = base64Decode(ivPart);
  const ciphertext = base64Decode(dataPart);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext.buffer as ArrayBuffer,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
