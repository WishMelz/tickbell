import type { RateLimit } from '@cloudflare/workers-types';
import type { RateLimiter, RateLimitResult } from '@tickbell/core';

export class CfRateLimiter implements RateLimiter {
  constructor(private readonly binding?: RateLimit) {}

  async limit(key: string): Promise<RateLimitResult> {
    if (!this.binding) {
      return { allowed: false, unavailable: true };
    }
    try {
      const outcome = await this.binding.limit({ key });
      return outcome.success ? { allowed: true } : { allowed: false, retryAfterSeconds: 60 };
    } catch {
      return { allowed: false, unavailable: true };
    }
  }
}
