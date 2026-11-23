import * as crypto from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions, Request } from 'express';
import { conflict, ValidationError } from '../../common/errors';
import { isValidTimezone } from '../../common/time';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { DatabaseService } from '../database/database.service';
import { SETTING_GLOBAL_TIMEZONE, SettingsService } from '../settings/settings.service';

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

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

@Injectable()
export class AuthService {
  private readonly ephemeralSecret = crypto.randomBytes(32).toString('hex');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly settings: SettingsService,
  ) {}

  /** True once first-run setup completed (DB password hash exists) or an optional env password is set. */
  isInitialized(): boolean {
    if (this.settings.getAuthPasswordHash()) return true;
    return this.config.adminPassword.length >= ADMIN_PASSWORD_MIN_LENGTH;
  }

  getConfigurationIssue(): ConfigurationIssue {
    if (this.settings.getAuthPasswordHash()) return null;
    if (!this.config.adminPassword) return 'missing';
    if (this.config.adminPassword.length < ADMIN_PASSWORD_MIN_LENGTH) return 'too_short';
    return null;
  }

  isConfigured(): boolean {
    return this.isInitialized();
  }

  /**
   * One-time first-run setup: persists salted scrypt password hash and session secret in SQLite.
   * Rejects with 409 if the system has already been initialized.
   */
  setup(input: { password: unknown; secret: unknown; globalTimezone?: unknown }): void {
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

    const passwordHash = hashPassword(password);
    const now = Date.now();

    this.database.transaction(() => {
      if (this.isInitialized()) {
        throw conflict('系统已完成初始化，请直接登录');
      }
      this.settings.setAuthPasswordHash(passwordHash, now);
      this.settings.setAuthSessionSecret(secret, now);
      if (timezone) {
        this.settings.setSetting(SETTING_GLOBAL_TIMEZONE, timezone, now);
      }
      this.settings.rotateSessionGeneration(now);
    });
  }

  changePassword(currentPassword: unknown, newPassword: unknown): void {
    if (typeof currentPassword !== 'string' || !currentPassword) {
      throw new ValidationError('请输入当前密码');
    }
    if (typeof newPassword !== 'string' || newPassword.length < ADMIN_PASSWORD_MIN_LENGTH) {
      throw new ValidationError(`新密码至少需要 ${ADMIN_PASSWORD_MIN_LENGTH} 个字符`);
    }
    if (!this.verifyPassword(currentPassword)) {
      throw new ValidationError('当前密码不正确');
    }

    const nextHash = hashPassword(newPassword);
    const now = Date.now();
    this.database.transaction(() => {
      this.settings.setAuthPasswordHash(nextHash, now);
      // Ensure DB has a persisted session secret if transitioning from env fallback
      if (!this.settings.getAuthSessionSecret()) {
        const seedSecret =
          this.config.sessionSecret.length >= SESSION_SECRET_MIN_LENGTH
            ? this.config.sessionSecret
            : crypto.randomBytes(32).toString('hex');
        this.settings.setAuthSessionSecret(seedSecret, now);
      }
      this.settings.rotateSessionGeneration(now);
    });
  }

  verifyPassword(submitted: string): boolean {
    const storedHash = this.settings.getAuthPasswordHash();
    if (storedHash) {
      return verifyPasswordHash(submitted, storedHash);
    }
    if (this.config.adminPassword.length < ADMIN_PASSWORD_MIN_LENGTH) return false;
    const submittedHash = crypto.createHash('sha256').update(submitted, 'utf8').digest();
    const configuredHash = crypto.createHash('sha256').update(this.config.adminPassword, 'utf8').digest();
    return crypto.timingSafeEqual(submittedHash, configuredHash);
  }

  private signingKey(): Buffer {
    const secret = this.settings.getAuthSessionSecret() || this.config.sessionSecret || this.ephemeralSecret;
    const passwordBinding = this.settings.getAuthPasswordHash() || this.config.adminPassword;
    return crypto.createHash('sha256').update(`tickbell-session-v1:${secret}:${passwordBinding}`, 'utf8').digest();
  }

  private sign(encodedPayload: string): string {
    return crypto.createHmac('sha256', this.signingKey()).update(encodedPayload, 'utf8').digest('base64url');
  }

  createSessionToken(): string {
    const payload: SessionPayload = {
      expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
      nonce: crypto.randomUUID(),
      version: this.settings.getSessionGeneration(),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = this.sign(encodedPayload);
    return `${encodedPayload}.${signature}`;
  }

  verifySessionToken(token: string | undefined): boolean {
    if (!token || !this.isInitialized()) return false;
    const separator = token.lastIndexOf('.');
    if (separator <= 0) return false;

    try {
      const encodedPayload = token.slice(0, separator);
      const signature = token.slice(separator + 1);
      const expectedSig = this.sign(encodedPayload);
      const sigBuf = Buffer.from(signature, 'utf8');
      const expectedBuf = Buffer.from(expectedSig, 'utf8');
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return false;
      }

      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<SessionPayload>;
      if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) {
        return false;
      }
      const currentVersion = this.settings.getSessionGeneration();
      if ((payload.version ?? '') !== currentVersion) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  extractTokenFromRequest(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, unknown> | undefined;
    if (cookies && typeof cookies[SESSION_COOKIE_NAME] === 'string') {
      return cookies[SESSION_COOKIE_NAME];
    }
    const header = request.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      if (part.slice(0, idx).trim() === SESSION_COOKIE_NAME) {
        return part.slice(idx + 1).trim();
      }
    }
    return undefined;
  }

  hasValidSession(request: Request): boolean {
    return this.verifySessionToken(this.extractTokenFromRequest(request));
  }

  private resolveCookieSecure(request?: Request): boolean {
    if (this.config.cookieSecure === 'true') return true;
    if (this.config.cookieSecure === 'false') return false;
    if (!request) return false;
    if (request.secure) return true;
    const proto = request.headers['x-forwarded-proto'];
    if (typeof proto === 'string') {
      return proto.split(',')[0]?.trim().toLowerCase() === 'https';
    }
    return false;
  }

  sessionCookieOptions(request?: Request): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: this.resolveCookieSecure(request),
      maxAge: SESSION_MAX_AGE_SECONDS * 1000,
    };
  }

  clearCookieOptions(request?: Request): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: this.resolveCookieSecure(request),
    };
  }
}
