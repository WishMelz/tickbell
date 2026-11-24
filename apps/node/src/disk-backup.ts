import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AUTO_BACKUP_FILE_RE,
  epochToIso,
  payloadTooLarge,
  type AutoBackupFileInfo,
  type AutoBackupStorage,
} from '@tickbell/core';

export class LocalDiskBackupStorage implements AutoBackupStorage {
  constructor(public readonly backupDir: string) {}

  async listFiles(): Promise<AutoBackupFileInfo[]> {
    if (!fs.existsSync(this.backupDir)) return [];
    const entries: Array<{ name: string; sizeBytes: number; mtimeMs: number }> = [];
    for (const name of fs.readdirSync(this.backupDir)) {
      if (!AUTO_BACKUP_FILE_RE.test(name)) continue;
      const fullPath = path.join(this.backupDir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          entries.push({ name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // ignore transient file errors
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    return entries.map((item) => ({
      name: item.name,
      sizeBytes: item.sizeBytes,
      createdAt: epochToIso(Math.floor(item.mtimeMs)),
    }));
  }

  async writeFile(name: string, content: string, now: number): Promise<AutoBackupFileInfo> {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const targetPath = path.join(this.backupDir, name);
    const tmpPath = `${targetPath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, targetPath);
      try {
        const ts = new Date(now);
        fs.utimesSync(targetPath, ts, ts);
      } catch {
        // best-effort timestamp alignment
      }
    } catch (error) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
      throw error;
    }
    const stat = fs.statSync(targetPath);
    return {
      name,
      sizeBytes: stat.size,
      createdAt: epochToIso(Math.floor(stat.mtimeMs)),
    };
  }

  async readFile(name: string, maxBytes: number): Promise<string | null> {
    const fullPath = path.join(this.backupDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) {
      throw payloadTooLarge('备份超过 32 MB，请直接从服务器目录获取');
    }
    return fs.readFileSync(fullPath, 'utf8');
  }

  async deleteFile(name: string): Promise<boolean> {
    const fullPath = path.join(this.backupDir, name);
    if (!fs.existsSync(fullPath)) return false;
    fs.unlinkSync(fullPath);
    return true;
  }

  async pruneFiles(maxFiles: number): Promise<void> {
    const files = await this.listFiles();
    for (let i = maxFiles; i < files.length; i += 1) {
      const target = path.join(this.backupDir, files[i]!.name);
      try {
        fs.unlinkSync(target);
      } catch {
        // ignore
      }
    }
  }
}
