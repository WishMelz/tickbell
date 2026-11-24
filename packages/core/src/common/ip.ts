import ipaddr from 'ipaddr.js';

/**
 * Normalizes a client IP for rate limiting:
 * - IPv4-mapped IPv6 -> IPv4
 * - IPv6 -> /64 prefix aggregation
 * - Invalid / missing -> 'unknown'
 */
export function normalizeClientIp(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  const candidate = raw.split(',')[0]?.trim();
  if (!candidate || !ipaddr.isValid(candidate)) return 'unknown';

  const parsed = ipaddr.process(candidate);
  if (parsed.kind() === 'ipv4') {
    return parsed.toString();
  }
  const parts = (parsed as ipaddr.IPv6).parts;
  return `${parts[0]!.toString(16)}:${parts[1]!.toString(16)}:${parts[2]!.toString(16)}:${parts[3]!.toString(16)}::/64`;
}
