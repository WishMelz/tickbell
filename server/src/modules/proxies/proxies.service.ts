import * as crypto from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { notFound, ValidationError } from '../../common/errors';
import { epochToIso } from '../../common/time';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import {
  pinnedHttpRequest,
  type PinnedHttpResponse,
  type PinnedRequestOptions,
  sanitizeSensitiveText,
} from '../notifications/http/pinned-fetch';
import {
  PROXY_PROTOCOLS,
  type ProxyProtocol,
  type ProxyTarget,
} from '../notifications/http/proxy-dispatcher';
import { parsePublicHttpUrl, PrivateNetworkPolicy } from '../notifications/http/url-policy';
import { ProxiesRepository, type ProxyRow } from './proxies.repository';

export const PROXY_HTTP_REQUEST = Symbol('PROXY_HTTP_REQUEST');
export type ProxyHttpRequestFn = (options: PinnedRequestOptions) => Promise<PinnedHttpResponse>;

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

@Injectable()
export class ProxiesService {
  private readonly policy: PrivateNetworkPolicy;
  private readonly httpRequest: ProxyHttpRequestFn;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly repo: ProxiesRepository,
    @Optional() @Inject(PROXY_HTTP_REQUEST) httpRequest?: ProxyHttpRequestFn,
  ) {
    this.policy = new PrivateNetworkPolicy(config.allowedPrivateHosts, config.allowPrivateUrls);
    this.httpRequest = httpRequest ?? pinnedHttpRequest;
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

  list(): ProxyView[] {
    const counts = this.repo.countChannelsByProxy();
    return this.repo.findAll().map((row) => this.toView(row, counts.get(row.id) ?? 0));
  }

  getById(id: string): ProxyView {
    const row = this.repo.findById(id);
    if (!row) throw notFound('代理配置不存在');
    return this.toView(row, this.repo.countChannelsForProxy(id));
  }

  getRow(id: string): ProxyRow | null {
    return this.repo.findById(id);
  }

  /**
   * Resolves a channel's `proxy_id` into an active `ProxyTarget`.
   * Fails explicitly if the bound proxy is disabled or missing rather than silently bypassing it.
   */
  resolveForChannel(proxyId: string | null | undefined): ResolvedChannelProxy {
    if (!proxyId) return { target: null };
    const row = this.repo.findById(proxyId);
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

  create(raw: unknown): ProxyView {
    if (this.repo.findAll().length >= MAX_PROXIES) {
      throw new ValidationError(`最多只能配置 ${MAX_PROXIES} 个代理`);
    }
    const parsed = this.parseInput(raw, null, true);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.repo.insert({
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

  update(id: string, raw: unknown): ProxyView {
    const existing = this.repo.findById(id);
    if (!existing) throw notFound('代理配置不存在');
    const parsed = this.parseInput(raw, existing, true);
    this.repo.update(id, {
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

  delete(id: string): { deleted: true; detachedChannels: number } {
    const existing = this.repo.findById(id);
    if (!existing) throw notFound('代理配置不存在');
    const detachedChannels = this.repo.countChannelsForProxy(id);
    this.repo.delete(id);
    return { deleted: true, detachedChannels };
  }

  async testSaved(id: string, rawBody?: unknown): Promise<ProxyTestResult> {
    const row = this.repo.findById(id);
    if (!row) throw notFound('代理配置不存在');
    const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? (rawBody as Record<string, unknown>)
      : {};
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
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError('代理校验参数必须是 JSON 对象');
    }
    const body = raw as Record<string, unknown>;
    const existingId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : null;
    const existing = existingId ? this.repo.findById(existingId) : null;
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
        headers: { 'User-Agent': 'TickBell-ProxyCheck/1.0' },
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
      return {
        ok: true,
        statusCode: response.status,
        latencyMs,
        targetUrl,
        error: null,
      };
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
      return {
        ok: false,
        statusCode: null,
        latencyMs,
        targetUrl,
        error: safeMsg || '代理连接失败',
      };
    }
  }
}
