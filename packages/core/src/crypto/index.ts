const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PBKDF2_DEFAULT_ITERATIONS = 100_000;

export function randomUuid(): string {
  return crypto.randomUUID();
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function randomHex(byteLength: number): string {
  return bytesToHex(randomBytes(byteLength));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(encoder.encode(text));
}

export function base64UrlToUtf8(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return decoder.decode(bytes);
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  return timingSafeEqualBytes(encoder.encode(a), encoder.encode(b));
}

function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as unknown as Uint8Array<ArrayBuffer>;
}

export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  const buf = await crypto.subtle.digest('SHA-256', toBufferSource(data));
  return new Uint8Array(buf);
}

export async function hmacSha256Bytes(key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? encoder.encode(key) : key;
  const dataBytes = typeof data === 'string' ? encoder.encode(data) : data;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, toBufferSource(dataBytes));
  return new Uint8Array(sig);
}

export async function hmacSha256Hex(key: string | Uint8Array, data: string | Uint8Array): Promise<string> {
  return bytesToHex(await hmacSha256Bytes(key, data));
}

export async function hmacSha256Base64(key: string | Uint8Array, data: string | Uint8Array): Promise<string> {
  return bytesToBase64(await hmacSha256Bytes(key, data));
}

export async function hmacSha256Base64Url(key: string | Uint8Array, data: string | Uint8Array): Promise<string> {
  return bytesToBase64Url(await hmacSha256Bytes(key, data));
}

/**
 * Hashes a password with Web Crypto PBKDF2-SHA256 (native BoringSSL on Cloudflare Workers, fast & within 10ms CPU).
 * Format: `pbkdf2-sha256$<iterations>$<saltHex>$<derivedHex>`
 */
export async function hashPasswordPbkdf2(
  password: string,
  iterations = PBKDF2_DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = randomBytes(16);
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toBufferSource(salt), iterations },
    baseKey,
    256,
  );
  return `pbkdf2-sha256$${iterations}$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(derived))}`;
}

export async function verifyPasswordPbkdf2(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) return false;
  const salt = hexToBytes(parts[2] ?? '');
  const expected = hexToBytes(parts[3] ?? '');
  if (!salt || !expected) return false;

  try {
    const baseKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: toBufferSource(salt), iterations },
      baseKey,
      expected.length * 8,
    );
    return timingSafeEqualBytes(new Uint8Array(derived), expected);
  } catch {
    return false;
  }
}
