import { describe, expect, it } from 'vitest';
import {
  backupFileName,
  parsePlainBackupFile,
  serializePlainBackup,
} from '../src/utils/fullBackup';

describe('fullBackup plain JSON serialization & validation', () => {
  it('serializes and parses tickbell-full-backup JSON', () => {
    const sample = {
      format: 'tickbell-full-backup',
      version: 2,
      exportedAt: '2026-11-23T02:00:00.000Z',
      reminders: [{ id: 'r1', title: '测试提醒' }],
    };

    const plainText = serializePlainBackup(sample);
    expect(parsePlainBackupFile(plainText)).toEqual(sample);
    expect(backupFileName(new Date(2026, 10, 24, 9, 5, 3))).toBe('tickbell-backup-20261124-090503.json');
  });

  it('rejects unsupported backup formats and invalid JSON', () => {
    expect(() => parsePlainBackupFile('{bad json')).toThrow('不是有效的 JSON');
    expect(() => parsePlainBackupFile(JSON.stringify({ format: 'unknown', version: 1 }))).toThrow('不受支持的备份文件格式');
  });
});
