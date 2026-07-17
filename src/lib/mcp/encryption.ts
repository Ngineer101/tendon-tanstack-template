const ENCRYPTION_ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;

export interface MCPEncryptionEnv {
  MCP_ENCRYPTION_KEY: string;
}

async function getKey(env: MCPEncryptionEnv): Promise<CryptoKey> {
  const keyBytes = Uint8Array.from(atob(env.MCP_ENCRYPTION_KEY), (c) => c.charCodeAt(0));

  if (keyBytes.length !== 32) {
    throw new Error("MCP_ENCRYPTION_KEY must be a 32-byte base64-encoded string");
  }

  return crypto.subtle.importKey("raw", keyBytes, { name: ENCRYPTION_ALGORITHM }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(env: MCPEncryptionEnv, plaintext: string): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt({ name: ENCRYPTION_ALGORITHM, iv }, key, encoded);

  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(env: MCPEncryptionEnv, data: string): Promise<string> {
  const key = await getKey(env);
  const combined = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

  if (combined.length < IV_LENGTH) {
    throw new Error("Invalid encrypted data");
  }

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: ENCRYPTION_ALGORITHM, iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}
