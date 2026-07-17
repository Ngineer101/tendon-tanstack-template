// AES-256-GCM encryption for MCP auth material (tokens, client secrets, PKCE
// verifiers). The key comes from the MCP_TOKEN_ENCRYPTION_KEY environment
// secret: 32 random bytes, base64-encoded (`openssl rand -base64 32`).

const PAYLOAD_VERSION = "v1";
const IV_LENGTH = 12;

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
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importAesKey(secret: string, usage: KeyUsage) {
  let keyBytes: Uint8Array;
  try {
    keyBytes = fromBase64(secret.trim());
  } catch {
    throw new Error("MCP_TOKEN_ENCRYPTION_KEY must be base64-encoded");
  }
  if (keyBytes.length !== 32) {
    throw new Error("MCP_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, [
    usage,
  ]);
}

export async function encryptSecret(encryptionKey: string, plaintext: string) {
  const key = await importAesKey(encryptionKey, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return [PAYLOAD_VERSION, toBase64(iv), toBase64(new Uint8Array(ciphertext))].join(".");
}

export async function decryptSecret(encryptionKey: string, payload: string) {
  const [version, ivPart, ciphertextPart, extra] = payload.split(".");
  if (version !== PAYLOAD_VERSION || !ivPart || !ciphertextPart || extra !== undefined) {
    throw new Error("Unrecognized encrypted payload format");
  }
  const key = await importAesKey(encryptionKey, "decrypt");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(ivPart) as BufferSource },
      key,
      fromBase64(ciphertextPart) as BufferSource,
    );
  } catch {
    throw new Error("Unable to decrypt payload");
  }
  return new TextDecoder().decode(plaintext);
}
