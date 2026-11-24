import type { RateLimiter, RateLimitResult } from '@tickbell/core';

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly maxRequests = 5,
    private readonly windowMs = 60_000,
  ) {}

  async limit(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);

    if (timestamps.length >= this.maxRequests) {
      this.buckets.set(key, timestamps);
      const oldest = timestamps[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSeconds };
    }

    timestamps.push(now);
    this.buckets.set(key, timestamps);

    // Opportunistic sweep to keep memory bounded
    if (this.buckets.size > 1000) {
      for (const [k, list] of this.buckets.entries()) {
        if (list.every((ts) => ts <= cutoff)) this.buckets.delete(k);
      }
    }

    return { allowed: true };
  }
}
