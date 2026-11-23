import ipaddr from 'ipaddr.js';
import type { Request } from 'express';

/**
 * Extracts a normalized client identifier for rate limiting.
 * Express's `req.ip` respects `trust proxy`; IPv4-mapped IPv6 is unmapped,
 * and IPv6 addresses are aggregated by `/64` prefix (matching Tips).
 */
export function clientRateLimitKey(req: Request): string {
  const raw = req.ip || req.socket?.remoteAddress || '';
  if (!raw || !ipaddr.isValid(raw)) return 'unknown';
  const address = ipaddr.process(raw);
  if (address.kind() === 'ipv6') {
    return `ipv6:${address.toByteArray().slice(0, 8).join('.')}`;
  }
  return address.toString();
}
