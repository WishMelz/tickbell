import { notFound, notImplemented, ValidationError } from '../common/errors';
import { epochToIso } from '../common/time';
import { randomUuid } from '../crypto/index';
import { sanitizeSensitiveText } from '../notifications/http/http-helpers';
import { parsePublicHttpUrl, type PrivateNetworkPolicy } from '../notifications/http/url-policy';
import {
  PROXY_PROTOCOLS,
  type HttpRequestFn,
  type ProxyProtocol,
  type ProxyTarget,
} from '../ports/index';
import type { ProxiesRepository, ProxyRow } from '../repositories/proxies.repository';

export const DEFAULT_PROXY_TEST_URL = 'https://www.gstatic.com/generate_204';
const MAX_PROXIES = 50;

export interface ProxyView {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  enabled: boolean;
  channelCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyTestResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  targetUrl: string;
  error: string | null;
}

export interface ResolvedChannelProxy {
  target: ProxyTarget | null;
  error?: string;
}

interface ParsedProxyInput {
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
  enabled: boolean;
}

export class ProxiesService {
  constructor(
    private readonly supported: boolean,
    private readonly policy: PrivateNetworkPolicy,
    private readonly repo: ProxiesRepository,
    private readonly httpRequest: HttpRequestFn,
  ) {}

  private assertSupported(): void {
    if (!this.supported) {
      throw notImplemented('Cloudflare 部署模式不支持自定义网络代理，出站请求已直连全球公网');
    }
  }

  private toView(row: ProxyRow, channelCount: number): ProxyView {
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      host: row.host,
      port: row.port,
      username: row.username,
      hasPassword: row.password.length > 0,
      enabled: row.enabled === 1,
      channelCount,
      createdAt: epochToIso(row.created_at),
      updatedAt: epochToIso(row.updated_at),
    };
  }

  private parseHost(raw: unknown): string {
    const host = typeof raw === 'string' ? raw.trim() : '';
    if (!host || host.length > 255) {
      throw new ValidationError('代理主机地址长度必须为 1 到 255 个字符');
    }
    if (/[\s/?#@]/.test(host) || host.includes('://')) {
      throw new ValidationError('代理主机地址只需填写域名或 IP，无需包含协议或路径');
    }
    return host;
  }

  private parseInput(raw: unknown, existing: ProxyRow | null, requireName = true): ParsedProxyInput {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError('代理配置必须是 JSON 对象');
    }
    const body = raw as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (requireName && (!name || name.length > 80)) {
      throw new ValidationError('代理名称长度必须为 1 到 80 个字符');
    }

    const rawProtocol = typeof body.protocol === 'string' ? body.protocol.trim().toLowerCase() : '';
    const normalizedProtocol = rawProtocol === 'socks5h' ? 'socks5' : rawProtocol;
    if (!(PROXY_PROTOCOLS as readonly string[]).includes(normalizedProtocol)) {
      throw new ValidationError('代理协议仅支持 http、https 或 socks5');
    }
    const protocol = normalizedProtocol as ProxyProtocol;

    const host = this.parseHost(body.host);
    const port = typeof body.port === 'number' ? body.port : Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ValidationError('代理端口必须为 1 到 65535 的整数');
    }

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (username.length > 128) {
      throw new ValidationError('代理用户名不能超过 128 个字符');
    }

    const clearPassword = body.clearPassword === true;
    let password: string;
    if (clearPassword) {
      password = '';
    } else if (typeof body.password === 'string' && body.password.length > 0) {
      if (body.password.length > 256) {
        throw new ValidationError('代理密码不能超过 256 个字符');
      }
      password = body.password;
    } else {
      password = existing?.password ?? '';
    }

    const enabled = body.enabled === undefined ? true : body.enabled === true;

    return {
      name: name || existing?.name || '临时代理',
      protocol,
      host,
      port,
      username,
      password,
      enabled,
    };
  }

  private parseTestUrl(raw: unknown): string {
    if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
      return DEFAULT_PROXY_TEST_URL;
    }
    if (typeof raw !== 'string') {
      throw new ValidationError('校验地址格式无效');
    }
    return parsePublicHttpUrl(raw.trim(), '校验地址', this.policy);
  }

  async list(): Promise<ProxyView[]> {
    this.assertSupported();
    const [counts, rows] = await Promise.all([this.repo.countChannelsByProxy(), this.repo.findAll()]);
    return rows.map((row) => this.toView(row, counts.get(row.id) ?? 0));
  }

  async getById(id: string): Promise<ProxyView> {
    this.assertSupported();
    const row = await this.repo.findById(id);
    if (!row) throw notFound('代理配置不存在');
    return this.toView(row, await this.repo.countChannelsForProxy(id));
  }

  async getRow(id: string): Promise<ProxyRow | null> {
    if (!this.supported) return null;
    return this.repo.findById(id);
  }

  async resolveForChannel(proxyId: string | null | undefined): Promise<ResolvedChannelProxy> {
    if (!proxyId || !this.supported) return { target: null };
    const row = await this.repo.findById(proxyId);
    if (!row) {
      return { target: null, error: '所选代理不存在，请在通知渠道中重新选择代理' };
    }
    if (row.enabled !== 1) {
      return { target: null, error: `代理“${row.name}”已停用，请在系统设置中启用或更改渠道代理` };
    }
    return {
      target: {
        protocol: row.protocol,
        host: row.host,
        port: row.port,
        username: row.username || undefined,
        password: row.password || undefined,
      },
    };
  }

  async create(raw: unknown): Promise<ProxyView> {
    this.assertSupported();
    if ((await this.repo.findAll()).length >= MAX_PROXIES) {
      throw new ValidationError(`最多只能配置 ${MAX_PROXIES} 个代理`);
    }
    const parsed = this.parseInput(raw, null, true);
    const id = randomUuid();
    const now = Date.now();
    await this.repo.insert({
      id,
      name: parsed.name,
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      enabled: parsed.enabled ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
    return this.getById(id);
  }

  async update(id: string, raw: unknown): Promise<ProxyView> {
    this.assertSupported();
    const existing = await this.repo.findById(id);
    if (!existing) throw notFound('代理配置不存在');
    const parsed = this.parseInput(raw, existing, true);
    await this.repo.update(id, {
      name: parsed.name,
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      enabled: parsed.enabled ? 1 : 0,
      updated_at: Date.now(),
    });
    return this.getById(id);
  }

  async delete(id: string): Promise<{ deleted: true; detachedChannels: number }> {
    this.assertSupported();
    const existing = await this.repo.findById(id);
    if (!existing) throw notFound('代理配置不存在');
    const detachedChannels = await this.repo.countChannelsForProxy(id);
    await this.repo.delete(id);
    return { deleted: true, detachedChannels };
  }

  async testSaved(id: string, rawBody?: unknown): Promise<ProxyTestResult> {
    this.assertSupported();
    const row = await this.repo.findById(id);
    if (!row) throw notFound('代理配置不存在');
    const body =
      rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};
    const targetUrl = this.parseTestUrl(body.testUrl);
    return this.executeProxyTest(
      {
        protocol: row.protocol,
        host: row.host,
        port: row.port,
        username: row.username || undefined,
        password: row.password || undefined,
      },
      targetUrl,
    );
  }

  async testAdhoc(raw: unknown): Promise<ProxyTestResult> {
    this.assertSupported();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError('代理校验参数必须是 JSON 对象');
    }
    const body = raw as Record<string, unknown>;
    const existingId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : null;
    const existing = existingId ? await this.repo.findById(existingId) : null;
    const parsed = this.parseInput(body, existing, false);
    const targetUrl = this.parseTestUrl(body.testUrl);
    return this.executeProxyTest(
      {
        protocol: parsed.protocol,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username || undefined,
        password: parsed.password || undefined,
      },
      targetUrl,
    );
  }

  private async executeProxyTest(proxy: ProxyTarget, targetUrl: string): Promise<ProxyTestResult> {
    const startedAt = Date.now();
    try {
      const response = await this.httpRequest({
        url: targetUrl,
        method: 'GET',
        headers: { 'User-Agent': 'TickBell-ProxyCheck/2.0' },
        timeoutMs: 10_000,
        policy: this.policy,
        proxy,
      });
      const latencyMs = Math.max(1, Date.now() - startedAt);
      if (response.status === 407) {
        return {
          ok: false,
          statusCode: 407,
          latencyMs,
          targetUrl,
          error: '代理认证失败（HTTP 407），请检查用户名和密码',
        };
      }
      if (response.status >= 500) {
        return {
          ok: false,
          statusCode: response.status,
          latencyMs,
          targetUrl,
          error: `代理或目标服务返回错误（HTTP ${response.status}）`,
        };
      }
      return { ok: true, statusCode: response.status, latencyMs, targetUrl, error: null };
    } catch (error) {
      const latencyMs = Math.max(1, Date.now() - startedAt);
      const rawMsg = error instanceof Error ? error.message : String(error);
      const safeMsg = sanitizeSensitiveText(rawMsg).slice(0, 300);
      if (/\b407\b/.test(safeMsg)) {
        return {
          ok: false,
          statusCode: 407,
          latencyMs,
          targetUrl,
          error: '代理认证失败（HTTP 407），请检查用户名和密码',
        };
      }
      return { ok: false, statusCode: null, latencyMs, targetUrl, error: safeMsg || '代理连接失败' };
    }
  }
}
