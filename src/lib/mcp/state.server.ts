/**
 * Signed, short-lived OAuth "state" tokens passed through the external MCP
 * authorization server and verified on our callback.
 *
 * The state carries enough to complete the flow without server-side session
 * storage: the target MCP server id, the owning user id, the PKCE verifier,
 * and an expiry. It is HMAC-signed with `MCP_ENCRYPTION_KEY` so it cannot be
 * forged or swapped. CSRF is mitigated because a forged state cannot produce a
 * valid signature.
 *
 * State is base64url(JSON.payload).signature, where signature is
 * HMAC-SHA-256 over the payload (hex).
 */
import { ApiError } from "#/lib/api-error";
import { OAUTH_STATE_TTL_MS } from "./config.server";

const ENCODER = new TextEncoder();

export interface OAuthState {
  /** MCP server id we are connecting. */
  serverId: string;
  /** Owning user id — checked against the session on callback. */
  userId: string;
  /** PKCE code_verifier used to exchange the auth code. */
  codeVerifier: string;
  /** Epoch ms when the state expires. */
  expiresAt: number;
  /** Random nonce to guarantee uniqueness of signatures. */
  nonce: string;
}

export type StateHmacKey = CryptoKey;

export async function deriveStateKey(secret: string): Promise<StateHmacKey> {
  if (!secret) throw new ApiError(500, "MCP signing key is not configured");
  const raw = ENCODER.encode(`mcp-oauth-state::${secret}`);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function hmac(key: StateHmacKey, data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.sign("HMAC", key, data as BufferSource);
  return new Uint8Array(buf);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(b64: string): Uint8Array {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? s : s + "=".repeat(4 - (s.length % 4));
  const binary = atob(pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function createStateToken(
  key: StateHmacKey,
  input: Omit<OAuthState, "expiresAt" | "nonce">,
  ttlMs: number = OAUTH_STATE_TTL_MS,
  now: number = Date.now(),
): Promise<string> {
  const state: OAuthState = {
    ...input,
    expiresAt: now + ttlMs,
    nonce: crypto.randomUUID(),
  };
  const payload = bytesToB64url(ENCODER.encode(JSON.stringify(state)));
  const sig = await hmac(key, ENCODER.encode(payload));
  return `${payload}.${bytesToHex(sig)}`;
}

export class InvalidStateError extends ApiError {
  constructor(message: string) {
    super(400, message);
    this.name = "InvalidStateError";
  }
}

export async function verifyStateToken(
  key: StateHmacKey,
  token: string,
  now: number = Date.now(),
): Promise<OAuthState> {
  if (typeof token !== "string" || !token.includes(".")) {
    throw new InvalidStateError("Missing OAuth state");
  }
  const [payloadPart, sigPart] = token.split(".");
  if (!payloadPart || !sigPart || !/^[0-9a-f]+$/.test(sigPart)) {
    throw new InvalidStateError("Malformed OAuth state");
  }

  const expected = await hmac(key, ENCODER.encode(payloadPart));
  const expectedHex = bytesToHex(expected);
  if (expectedHex.length !== sigPart.length || !timingSafeEqualHex(expectedHex, sigPart)) {
    throw new InvalidStateError("Invalid OAuth state signature");
  }

  let state: OAuthState;
  try {
    state = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadPart))) as OAuthState;
  } catch {
    throw new InvalidStateError("Corrupt OAuth state");
  }

  if (
    typeof state.serverId !== "string" ||
    typeof state.userId !== "string" ||
    typeof state.codeVerifier !== "string" ||
    typeof state.expiresAt !== "number"
  ) {
    throw new InvalidStateError("Incomplete OAuth state");
  }

  if (now >= state.expiresAt) {
    throw new InvalidStateError("OAuth state has expired");
  }
  return state;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
