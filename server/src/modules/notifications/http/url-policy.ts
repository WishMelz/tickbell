import ipaddr from 'ipaddr.js';
import { ValidationError } from '../../../common/errors';

/**
 * Network access policy for outbound notification URLs.
 * - When `allowPrivate = true` (default for self-hosted deployments), local/Docker/LAN URLs
 *   (e.g. self-hosted `bark-server` at `http://192.168.1.10:8080` or `http://bark:8080`) are allowed.
 * - When `allowPrivate = false`, only public unicast addresses are allowed unless matched by `entries`
 *   (hostnames, IPs, or CIDRs from `ALLOWED_PRIVATE_HOSTS`).
 */
export class PrivateNetworkPolicy {
  private readonly hostnames = new Set<string>();
  private readonly ranges: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> = [];
  readonly allowPrivate: boolean;

  constructor(entries: readonly string[] = [], allowPrivate = false) {
    this.allowPrivate = allowPrivate;
    for (const raw of entries) {
      const entry = normalizeHostname(raw);
      if (!entry) continue;
      if (entry.includes('/')) {
        try {
          this.ranges.push(ipaddr.parseCIDR(entry));
          continue;
        } catch {
          // fall through: treat as hostname
        }
      }
      if (ipaddr.isValid(entry)) {
        const address = ipaddr.process(entry);
        this.ranges.push([address, address.kind() === 'ipv4' ? 32 : 128]);
        continue;
      }
      this.hostnames.add(entry);
    }
  }

  get isEmpty(): boolean {
    return !this.allowPrivate && this.hostnames.size === 0 && this.ranges.length === 0;
  }

  /** Hostname (or IP literal) explicitly allowed. */
  isHostAllowed(hostname: string): boolean {
    if (this.allowPrivate) return true;
    const normalized = normalizeHostname(hostname);
    if (this.hostnames.has(normalized)) return true;
    return ipaddr.isValid(normalized) && this.isAddressAllowed(normalized);
  }

  isAddressAllowed(address: string): boolean {
    if (this.allowPrivate) return true;
    if (!ipaddr.isValid(address)) return false;
    const parsed = ipaddr.process(address);
    return this.ranges.some(([range, bits]) => range.kind() === parsed.kind() && parsed.match(range, bits));
  }
}

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** Public unicast address (rejects loopback, private, link-local, CGNAT, ULA, mapped private v4, ...). */
export function isPublicUnicast(address: string): boolean {
  return ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';
}

/**
 * Validates HTTP(S) URLs without embedded credentials.
 * Blocks localhost/.local/private IP literals only when `policy.allowPrivate` is false.
 */
export function parsePublicHttpUrl(value: string, label: string, policy?: PrivateNetworkPolicy): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`${label} 必须是合法 URL`);
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ValidationError(`${label} 仅支持无凭据的 HTTP/HTTPS URL`);
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new ValidationError(`${label} 必须是合法 URL`);
  }
  if (policy?.isHostAllowed(hostname)) return url.toString();
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || (ipaddr.isValid(hostname) && !isPublicUnicast(hostname))
  ) {
    throw new ValidationError(`${label} 不能指向本机或私有网络`);
  }
  return url.toString();
}
