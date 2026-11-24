import { conflict, ValidationError } from '../common/errors';
import { isValidTimezone } from '../common/time';
import {
  base64UrlToUtf8,
  hashPasswordPbkdf2,
  hmacSha256Base64Url,
  randomHex,
  randomUuid,
  sha256Bytes,
  timingSafeEqualBytes,
  timingSafeEqualStrings,
  utf8ToBase64Url,
  verifyPasswordPbkdf2,
} from '../crypto/index';
import type { CoreConfig, DbAdapter, SqlStatement } from '../ports/index';
import type { SettingsRepository } from '../repositories/settings.repository';
import {
  SETTING_AUTH_PASSWORD_HASH,
  SETTING_AUTH_SESSION_SECRET,
  SETTING_GLOBAL_TIMEZONE,
  SETTING_SESSION_GENERATION,
} from './settings.service';

export const SESSION_COOKIE_NAME = 'tickbell_session';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const ADMIN_PASSWORD_MIN_LENGTH = 6;
export const SESSION_SECRET_MIN_LENGTH = 16;

export type ConfigurationIssue = 'missing' | 'too_short' | null;

interface SessionPayload {
  expiresAt: number;
  nonce: string;
  version: string;
}

export class AuthService {
  private readonly ephemeralSecret = randomHex(32);

  constructor(
    private readonly config: CoreConfig,
    private readonly db: DbAdapter,
    private readonly settingsRepo: SettingsRepository,
  ) {}

  async isInitialized(): Promise<boolean> {
    const hash = await this.settingsRepo.get(SETTING_AUTH_PASSWORD_HASH);
    if (hash && hash.length > 0) return true;
    return this.config.adminPassword.length >= ADMIN_PASSWORD_MIN_LENGTH;
  }

  async getConfigurationIssue(): Promise<ConfigurationIssue> {
    const hash = await this.settingsRepo.get(SETTING_AUTH_PASSWORD_HASH);
    if (hash && hash.length > 0) return null;
    if (!this.config.adminPassword) return 'missing';
    if (this.config.adminPassword.length < ADMIN_PASSWORD_MIN_LENGTH) return 'too_short';
    return null;
  }

  /**
   * Race-safe first-run setup: persists salted PBKDF2 password hash & session secret into `settings`.
   * Rejects with 409 if the system has already been initialized.
   */
  async setup(input: { password: unknown; secret: unknown; globalTimezone?: unknown }): Promise<void> {
    const password = typeof input.password === 'string' ? input.password : '';
    const secret = typeof input.secret === 'string' ? input.secret.trim() : '';
    const timezone = typeof input.globalTimezone === 'string' ? input.globalTimezone.trim() : '';

    if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
      throw new ValidationError(`管理密码至少需要 ${ADMIN_PASSWORD_MIN_LENGTH} 个字符`);
    }
    if (secret.length < SESSION_SECRET_MIN_LENGTH) {
      throw new ValidationError(`系统密钥至少需要 ${SESSION_SECRET_MIN_LENGTH} 个字符`);
    }
    if (timezone && !isValidTimezone(timezone)) {
      throw new ValidationError('全局时区无效');
    }

    if (await this.isInitialized()) {
      throw conflict('系统已完成初始化，请直接登录');
    }

    const passwordHash = await hashPasswordPbkdf2(password);
    const now = Date.now();

    // Atomic first-write guard via PRIMARY KEY uniqueness on settings(key)
    const claim = await this.db.run(
      this.settingsRepo.insertIgnoreStatement(SETTING_AUTH_PASSWORD_HASH, passwordHash, now),
    );
    if (claim.changes === 0) {
      throw conflict('系统已完成初始化，请直接登录');
    }

    const stmts: SqlStatement[] = [
      this.settingsRepo.upsertStatement(SETTING_AUTH_SESSION_SECRET, secret, now),
      this.settingsRepo.upsertStatement(SETTING_SESSION_GENERATION, randomUuid(), now),
    ];
    if (timezone) {
      stmts.push(this.settingsRepo.upsertStatement(SETTING_GLOBAL_TIMEZONE, timezone, now));
    }
    await this.db.batch(stmts);
  }

  async changePassword(currentPassword: unknown, newPassword: unknown): Promise<void> {
    if (typeof currentPassword !== 'string' || !currentPassword) {
      throw new ValidationError('请输入当前密码');
    }
    if (typeof newPassword !== 'string' || newPassword.length < ADMIN_PASSWORD_MIN_LENGTH) {
      throw new ValidationError(`新密码至少需要 ${ADMIN_PASSWORD_MIN_LENGTH} 个字符`);
    }
    if (!(await this.verifyPassword(currentPassword))) {
      throw new ValidationError('当前密码不正确');
    }

    const nextHash = await hashPasswordPbkdf2(newPassword);
    const existingSecret = await this.settingsRepo.get(SETTING_AUTH_SESSION_SECRET);
    const now = Date.now();
    const stmts: SqlStatement[] = [
      this.settingsRepo.upsertStatement(SETTING_AUTH_PASSWORD_HASH, nextHash, now),
      this.settingsRepo.upsertStatement(SETTING_SESSION_GENERATION, randomUuid(), now),
    ];
    if (!existingSecret) {
      const seedSecret =
        this.config.sessionSecret.length >= SESSION_SECRET_MIN_LENGTH
          ? this.config.sessionSecret
          : randomHex(32);
      stmts.push(this.settingsRepo.upsertStatement(SETTING_AUTH_SESSION_SECRET, seedSecret, now));
    }
    await this.db.batch(stmts);
  }

  /**
   * Verifies password against stored PBKDF2 hash or optional env `ADMIN_PASSWORD` fallback.
   */
  async verifyPassword(submitted: string): Promise<boolean> {
    const storedHash = await this.settingsRepo.get(SETTING_AUTH_PASSWORD_HASH);
    if (storedHash) {
      if (storedHash.startsWith('pbkdf2-sha256$')) {
        return verifyPasswordPbkdf2(submitted, storedHash);
      }
      return false;
    }

    if (this.config.adminPassword.length < ADMIN_PASSWORD_MIN_LENGTH) return false;
    const [submittedHash, configuredHash] = await Promise.all([
      sha256Bytes(submitted),
      sha256Bytes(this.config.adminPassword),
    ]);
    return timingSafeEqualBytes(submittedHash, configuredHash);
  }

  private async signingKey(): Promise<Uint8Array> {
    const map = await this.settingsRepo.getMany([SETTING_AUTH_SESSION_SECRET, SETTING_AUTH_PASSWORD_HASH]);
    const secret = map.get(SETTING_AUTH_SESSION_SECRET) || this.config.sessionSecret || this.ephemeralSecret;
    const passwordBinding = map.get(SETTING_AUTH_PASSWORD_HASH) || this.config.adminPassword;
    return sha256Bytes(`tickbell-session-v1:${secret}:${passwordBinding}`);
  }

  async createSessionToken(): Promise<string> {
    // Ensure a stable signing secret is persisted when ADMIN_PASSWORD is supplied via env without SESSION_SECRET
    // (critical on stateless Cloudflare Workers where in-memory ephemeralSecret resets per request).
    if (!this.config.sessionSecret) {
      const existingSecret = await this.settingsRepo.get(SETTING_AUTH_SESSION_SECRET);
      if (!existingSecret) {
        await this.db.run(
          this.settingsRepo.insertIgnoreStatement(SETTING_AUTH_SESSION_SECRET, randomHex(32), Date.now()),
        );
      }
    }
    const version = (await this.settingsRepo.get(SETTING_SESSION_GENERATION)) ?? '';
    const payload: SessionPayload = {
      expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
      nonce: randomUuid(),
      version,
    };
    const encodedPayload = utf8ToBase64Url(JSON.stringify(payload));
    const key = await this.signingKey();
    const signature = await hmacSha256Base64Url(key, encodedPayload);
    return `${encodedPayload}.${signature}`;
  }

  async verifySessionToken(token: string | undefined): Promise<boolean> {
    if (!token || !(await this.isInitialized())) return false;
    const separator = token.lastIndexOf('.');
    if (separator <= 0) return false;

    try {
      const encodedPayload = token.slice(0, separator);
      const signature = token.slice(separator + 1);
      const key = await this.signingKey();
      const expectedSig = await hmacSha256Base64Url(key, encodedPayload);
      if (!timingSafeEqualStrings(signature, expectedSig)) {
        return false;
      }

      const payload = JSON.parse(base64UrlToUtf8(encodedPayload)) as Partial<SessionPayload>;
      if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) {
        return false;
      }
      const currentVersion = (await this.settingsRepo.get(SETTING_SESSION_GENERATION)) ?? '';
      if ((payload.version ?? '') !== currentVersion) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  extractTokenFromCookieHeader(cookieHeader: string | undefined): string | undefined {
    if (!cookieHeader) return undefined;
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      if (part.slice(0, idx).trim() === SESSION_COOKIE_NAME) {
        return part.slice(idx + 1).trim();
      }
    }
    return undefined;
  }

  resolveCookieSecure(requestUrl: string, forwardedProto?: string | null): boolean {
    if (this.config.cookieSecure === 'true') return true;
    if (this.config.cookieSecure === 'false') return false;
    if (forwardedProto) {
      return forwardedProto.split(',')[0]?.trim().toLowerCase() === 'https';
    }
    try {
      return new URL(requestUrl).protocol === 'https:';
    } catch {
      return false;
    }
  }
}
