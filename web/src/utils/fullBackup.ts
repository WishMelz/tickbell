/**
 * TickBell 全量明文 JSON 备份序列化与格式校验工具（`tickbell-full-backup`）。
 */

export const MAX_PLAIN_BYTES = 32 * 1024 * 1024;
export const MAX_BACKUP_FILE_BYTES = 45 * 1024 * 1024;

const encoder = new TextEncoder();

export function serializePlainBackup(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (encoder.encode(text).byteLength > MAX_PLAIN_BYTES) {
    throw new Error('备份超过 32 MB，请改用服务器上的 SQLite 文件备份');
  }
  return text;
}

/** 校验并解析明文全量备份（tickbell-full-backup） */
export function parsePlainBackupFile(text: string): unknown {
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
  if (format !== 'tickbell-full-backup') {
    throw new Error('不受支持的备份文件格式');
  }
  return parsed;
}

export function backupFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `tickbell-backup-${stamp}.json`;
}
