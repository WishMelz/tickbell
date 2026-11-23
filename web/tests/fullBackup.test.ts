import { describe, expect, it } from 'vitest';
import {
  BACKUP_ITERATIONS,
  decryptFullBackup,
  encryptFullBackup,
  inspectBackupFile,
  serializePlainBackup,
} from '../src/utils/fullBackup';

describe('fullBackup plain export & legacy encrypted compatibility', () => {
  it('serializes and detects plaintext tickbell-full-backup v2 and legacy tips-full-backup JSON', () => {
    const sample = {
      format: 'tickbell-full-backup',
      version: 2,
      exportedAt: '2026-11-23T02:00:00.000Z',
      reminders: [{ id: 'r1', title: '测试提醒' }],
    };

    const plainText = serializePlainBackup(sample);
    const inspected = inspectBackupFile(plainText);
    expect(inspected).toEqual({ kind: 'plain', data: sample });

    const legacyPlain = serializePlainBackup({ ...sample, format: 'tips-full-backup' });
    expect(inspectBackupFile(legacyPlain).kind).toBe('plain');
  });

  it('still decrypts legacy tips-encrypted-backup v1 container exported from Tips', async () => {
    const sample = {
      format: 'tips-full-backup',
      version: 2,
      exportedAt: '2026-11-23T02:00:00.000Z',
      reminders: [{ id: 'r1', title: '测试提醒' }],
    };

    const encryptedText = await encryptFullBackup(sample, 'super-secret-backup-pass');
    expect(inspectBackupFile(encryptedText)).toEqual({ kind: 'encrypted' });
    const container = JSON.parse(encryptedText) as Record<string, unknown>;
    expect(container.format).toBe('tips-encrypted-backup');
    expect(container.version).toBe(1);
    expect(container.cipher).toBe('AES-256-GCM');
    expect(container.kdf).toBe('PBKDF2-SHA256');
    expect(container.iterations).toBe(BACKUP_ITERATIONS);

    const decrypted = await decryptFullBackup(encryptedText, 'super-secret-backup-pass');
    expect(decrypted).toEqual(sample);

    await expect(decryptFullBackup(encryptedText, 'wrong-password-1234')).rejects.toThrow('备份密码不正确');
  }, 15_000);
});
