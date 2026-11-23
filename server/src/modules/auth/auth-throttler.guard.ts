import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { clientRateLimitKey } from '../../common/ip';

/**
 * Rate limiter guard applied explicitly to password-verifying endpoints
 * (`/api/auth/login`, `/api/backup/export`, `/api/backup/restore`).
 * Uses normalized IP (with IPv6 /64 aggregation) as tracker.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return `auth:${clientRateLimitKey(req as unknown as Request)}`;
  }
}
