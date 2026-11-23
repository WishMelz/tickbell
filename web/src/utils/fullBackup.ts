/**
 * 浏览器端全量备份加解密。移植自 Tips frontend/src/fullBackup.ts，文件格式必须与 Tips 100% 兼容：
 *   { format: 'tips-encrypted-backup', version: 1, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA256',
 *     iterations: 600000, salt: base64(16B), iv: base64(12B), ciphertext: base64 }
 * 明文是服务端 /api/backup/export 返回的 JSON（tips-full-backup v1/v2）。
 * 修改此文件前请确认旧备份仍可解密（tests/fullBackup.test.ts）。
 */

export const MAX_PLAIN_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_FILE_BYTES = 45 * 1024 * 1024;
export const BACKUP_ITERATIONS = 600000;
export const MIN_BACKUP_PASSWORD_LENGTH = 12;

const encoder = new TextEncoder();

export interface EncryptedBackupContainer {
  format: 'tips-encrypted-backup';
  version: 1;
  cipher: 'AES-256-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(''));
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations = BACKUP_ITERATIONS): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) throw new Error('加密备份需要 HTTPS 或本机（localhost）安全连接');
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations, salt },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptFullBackup(value: unknown, password: string): Promise<string> {
  if (password.length < MIN_BACKUP_PASSWORD_LENGTH) throw new Error(`备份密码至少需要 ${MIN_BACKUP_PASSWORD_LENGTH} 个字符`);
  const plaintext = encoder.encode(JSON.stringify(value));
  if (plaintext.byteLength > MAX_PLAIN_BYTES) throw new Error('备份超过 32 MB，无法在浏览器中加密，请改用服务器上的 SQLite 文件备份');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const container: EncryptedBackupContainer = {
    format: 'tips-encrypted-backup',
    version: 1,
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: BACKUP_ITERATIONS,
    salt: base64(salt),
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(encrypted)),
  };
  return JSON.stringify(container);
}

export async function decryptFullBackup(text: string, password: string): Promise<unknown> {
  if (!password) throw new Error('请输入备份密码');
  if (text.length > MAX_BACKUP_FILE_BYTES || encoder.encode(text).byteLength > MAX_BACKUP_FILE_BYTES) {
    throw new Error('备份文件超过 45 MB');
  }
  let container: unknown;
  try {
    container = JSON.parse(text);
  } catch {
    throw new Error('备份文件不是有效的 JSON');
  }
  if (!container || typeof container !== 'object' || Array.isArray(container)) throw new Error('加密备份格式无效');
  const data = container as Record<string, unknown>;
  if (
    data.format !== 'tips-encrypted-backup' ||
    data.version !== 1 ||
    data.cipher !== 'AES-256-GCM' ||
    data.kdf !== 'PBKDF2-SHA256' ||
    data.iterations !== BACKUP_ITERATIONS ||
    typeof data.salt !== 'string' ||
    typeof data.iv !== 'string' ||
    typeof data.ciphertext !== 'string' ||
    data.salt.length !== 24 ||
    data.iv.length !== 16
  ) {
    throw new Error('加密备份格式或版本不受支持');
  }
  try {
    const salt = decode(data.salt);
    const iv = decode(data.iv);
    const ciphertext = decode(data.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16 || ciphertext.length > MAX_PLAIN_BYTES + 16) {
      throw new Error('Invalid size');
    }
    const key = await deriveKey(password, salt);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    throw new Error('备份密码不正确，或备份文件已损坏');
  }
}

export function serializePlainBackup(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (encoder.encode(text).byteLength > MAX_PLAIN_BYTES) {
    throw new Error('备份超过 32 MB，请改用服务器上的 SQLite 文件备份');
  }
  return text;
}

export type InspectedBackupFile = { kind: 'plain'; data: unknown } | { kind: 'encrypted' };

/** 自动识别明文全量备份（tickbell-full-backup / tips-full-backup）或旧版加密备份（tips-encrypted-backup） */
export function inspectBackupFile(text: string): InspectedBackupFile {
  if (text.length > MAX_BACKUP_FILE_BYTES || encoder.encode(text).byteLength > MAX_BACKUP_FILE_BYTES) {
    throw new Error('备份文件超过 45 MB');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('备份文件不是有效的 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('备份文件格式无效');
  }
  const format = (parsed as Record<string, unknown>).format;
  if (format === 'tickbell-full-backup' || format === 'tips-full-backup') {
    return { kind: 'plain', data: parsed };
  }
  if (format === 'tips-encrypted-backup') {
    return { kind: 'encrypted' };
  }
  throw new Error('不受支持的备份文件格式');
}

export function backupFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `tickbell-backup-${stamp}.json`;
}
