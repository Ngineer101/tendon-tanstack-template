import { ApiError } from "#/lib/api-error";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

const MAX_JSON_BYTES = 64 * 1024;
const OUTBOUND_TIMEOUT_MS = 8_000;
const HOSTNAME_BLOCKLIST = [
  ".internal",
  ".invalid",
  ".local",
  ".localhost",
  ".onion",
  ".test",
  ".home.arpa",
];

export interface FetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export type ResolveHostname = (hostname: string) => Promise<string[]>;

export interface OutboundRequestOptions {
  fetcher?: FetchLike;
  resolveHostname?: ResolveHostname;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function base64UrlEncode(bytes: Uint8Array) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function deriveEncryptionKey(secret: string) {
  const trimmed = secret.trim();
  if (!trimmed) throw new ApiError(500, "MCP encryption is not configured");

  try {
    const decoded = base64ToBytes(trimmed);
    if (decoded.byteLength === 32) return decoded;
  } catch {
    // A non-base64 secret is handled as high-entropy UTF-8 input below.
  }

  const raw = new TextEncoder().encode(trimmed);
  if (raw.byteLength < 32) {
    throw new ApiError(500, "MCP encryption key must contain at least 32 bytes of entropy");
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
}

async function importEncryptionKey(secret: string) {
  return crypto.subtle.importKey("raw", await deriveEncryptionKey(secret), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(value: unknown, secret: string, purpose = "mcp-data") {
  const key = await importEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(purpose);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    plaintext,
  );

  return JSON.stringify({
    v: 1,
    alg: "A256GCM",
    purpose,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptJson<T>(encrypted: string, secret: string, purpose = "mcp-data") {
  let envelope: {
    v?: unknown;
    alg?: unknown;
    purpose?: unknown;
    iv?: unknown;
    ciphertext?: unknown;
  };
  try {
    envelope = JSON.parse(encrypted) as typeof envelope;
  } catch {
    throw new ApiError(500, "Stored MCP credentials are invalid");
  }

  if (
    envelope.v !== 1 ||
    envelope.alg !== "A256GCM" ||
    envelope.purpose !== purpose ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new ApiError(500, "Unsupported MCP encryption envelope");
  }

  try {
    const iv = base64ToBytes(envelope.iv);
    if (iv.byteLength !== 12) throw new Error("Invalid IV");
    const key = await importEncryptionKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(purpose),
      },
      key,
      base64ToBytes(envelope.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "Stored MCP credentials could not be decrypted");
  }
}

function isPublicIpv4(value: string) {
  const parts = value.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(value: string) {
  let address: string;
  try {
    address = new URL(`https://[${value}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return false;
  }
  if (!address.includes(":")) return false;
  if (address === "::" || address === "::1") return false;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("ff")) {
    return false;
  }
  if (/^fe[89ab]/.test(address)) return false;
  if (/^fe[c-f]/.test(address)) return false;
  if (address.startsWith("2001:db8:")) return false;
  if (address.startsWith("::ffff:")) {
    return isPublicIpv4(address.slice("::ffff:".length));
  }
  return true;
}

function isIpAddress(value: string) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.includes(":");
}

export function assertPublicIpAddress(value: string) {
  const isPublic = value.includes(":") ? isPublicIpv6(value) : isPublicIpv4(value);
  if (!isPublic) throw new ApiError(400, "MCP server resolves to a restricted network");
}

export function normalizeMcpServerUrl(value: string) {
  if (value.length > 2_048) throw new ApiError(400, "MCP server URL is too long");

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ApiError(400, "Enter a valid MCP server URL");
  }

  if (parsed.protocol !== "https:") {
    throw new ApiError(400, "MCP server URLs must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(400, "MCP server URLs cannot include credentials");
  }

  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname === "metadata.google.internal" ||
    HOSTNAME_BLOCKLIST.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new ApiError(400, "MCP server URL points to a restricted host");
  }
  // IPv6 DNS answers are supported, but literals are rejected to keep URL parsing and
  // private-range policy conservative across runtimes.
  if (hostname.includes(":")) {
    throw new ApiError(400, "MCP server URL points to a restricted host");
  }
  if (isIpAddress(hostname)) assertPublicIpAddress(hostname);

  parsed.hostname = hostname;
  parsed.hash = "";
  if (parsed.pathname === "") parsed.pathname = "/";
  return parsed.toString();
}

async function fetchWithTimeout(fetcher: FetchLike, url: string, init: RequestInit = {}) {
  try {
    return await fetcher(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(502, "The MCP server did not respond in time");
  }
}

export async function readBoundedText(response: Response, limit = MAX_JSON_BYTES) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    await response.body?.cancel();
    throw new ApiError(502, "The MCP server response was too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(502, "The MCP server response was too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export async function readBoundedJson(response: Response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    await response.body?.cancel();
    throw new ApiError(502, "The MCP server returned an unexpected response format");
  }
  try {
    return JSON.parse(await readBoundedText(response)) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "The MCP server returned invalid JSON");
  }
}

interface DnsJsonAnswer {
  type?: unknown;
  data?: unknown;
}

interface DnsJsonResponse {
  Status?: unknown;
  Answer?: unknown;
}

export async function resolveHostnameWithCloudflare(hostname: string) {
  if (isIpAddress(hostname)) {
    assertPublicIpAddress(hostname);
    return [hostname];
  }

  const answers = await Promise.all(
    ["A", "AAAA"].map(async (type) => {
      const url = new URL("https://cloudflare-dns.com/dns-query");
      url.searchParams.set("name", hostname);
      url.searchParams.set("type", type);
      const response = await fetchWithTimeout(fetch, url.toString(), {
        headers: { accept: "application/dns-json" },
      });
      if (!response.ok) throw new ApiError(502, "Unable to verify the MCP server hostname");
      const body = (await readBoundedJson(response)) as DnsJsonResponse;
      if (body.Status !== 0 && body.Status !== 3) {
        throw new ApiError(502, "Unable to verify the MCP server hostname");
      }
      if (!Array.isArray(body.Answer)) return [];
      return body.Answer.flatMap((answer) => {
        const item = answer as DnsJsonAnswer;
        if ((item.type === 1 || item.type === 28) && typeof item.data === "string") {
          return [item.data];
        }
        return [];
      });
    }),
  );

  const addresses = answers.flat();
  if (addresses.length === 0) throw new ApiError(502, "MCP server hostname could not be resolved");
  for (const address of addresses) assertPublicIpAddress(address);
  return addresses;
}

export async function safeOutboundFetch(
  value: string,
  init: RequestInit = {},
  options: OutboundRequestOptions = {},
) {
  const url = await assertSafeOutboundUrl(value, options.resolveHostname);
  return fetchWithTimeout(options.fetcher ?? fetch, url, init);
}

export async function assertSafeOutboundUrl(
  value: string,
  resolveHostname: ResolveHostname = resolveHostnameWithCloudflare,
) {
  const url = normalizeMcpServerUrl(value);
  const addresses = await resolveHostname(new URL(url).hostname);
  if (addresses.length === 0) throw new ApiError(502, "MCP server hostname could not be resolved");
  for (const address of addresses) assertPublicIpAddress(address);
  return url;
}
