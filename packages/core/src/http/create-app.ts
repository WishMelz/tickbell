import { Hono, type Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { AppError, ValidationError } from '../common/errors';
import { normalizeClientIp } from '../common/ip';
import { epochToIso } from '../common/time';
import type { ChannelProvider } from '../notifications/channel-provider.interface';
import { createDefaultChannelRegistry } from '../notifications/channel-registry';
import { PrivateNetworkPolicy } from '../notifications/http/url-policy';
import {
  consoleLogger,
  type AutoBackupStorage,
  type CoreConfig,
  type CoreLogger,
  type DbAdapter,
  type HttpTransport,
  type RateLimiter,
  type RuntimeStatusMeta,
} from '../ports/index';
import { ChannelsRepository } from '../repositories/channels.repository';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { ProxiesRepository } from '../repositories/proxies.repository';
import { RemindersRepository } from '../repositories/reminders.repository';
import { SettingsRepository } from '../repositories/settings.repository';
import { AuthService, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from '../services/auth.service';
import { BackupService } from '../services/backup.service';
import { ChannelsService } from '../services/channels.service';
import { DeliveriesService } from '../services/deliveries.service';
import { ProxiesService } from '../services/proxies.service';
import { RemindersService } from '../services/reminders.service';
import { CoreScheduler } from '../services/scheduler.service';
import { SettingsService } from '../services/settings.service';

export interface CreateCoreAppDeps {
  config: CoreConfig;
  db: DbAdapter;
  http: HttpTransport;
  rateLimiter: RateLimiter;
  getRuntimeMeta: () => RuntimeStatusMeta;
  autoBackupStorage?: AutoBackupStorage;
  extraProviders?: readonly ChannelProvider[];
  logger?: CoreLogger;
  /** Optional runtime-specific client IP extractor (e.g. CF-Connecting-IP on Workers, socket/XFF on Node). */
  getClientIp?: (c: Context) => string | undefined;
  /** Whether to trust `X-Forwarded-Proto` when `COOKIE_SECURE=auto` (true behind reverse proxy, false on direct/CF). */
  trustForwardedProto?: boolean;
  /** Optional fallback handler for non-API routes (e.g. Cloudflare ASSETS or Node static files). */
  fallbackHandler?: (c: Context) => Promise<Response> | Response;
}

export interface CoreAppBundle {
  app: Hono;
  scheduler: CoreScheduler;
  backup: BackupService;
  auth: AuthService;
  settings: SettingsService;
  reminders: RemindersService;
  channels: ChannelsService;
  deliveries: DeliveriesService;
  proxies: ProxiesService;
}

const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/auth/logout',
]);

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError('请求体不是有效的 JSON');
  }
}

function resolveClientIp(c: Context): string {
  return normalizeClientIp(c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For'));
}

export function createCoreApp(deps: CreateCoreAppDeps): CoreAppBundle {
  const logger = deps.logger ?? consoleLogger;
  const policy = new PrivateNetworkPolicy(deps.config.allowedPrivateHosts, deps.config.allowPrivateUrls);
  const registry = createDefaultChannelRegistry(policy, deps.http.post, deps.extraProviders);

  const settingsRepo = new SettingsRepository(deps.db);
  const proxiesRepo = new ProxiesRepository(deps.db);
  const channelsRepo = new ChannelsRepository(deps.db);
  const remindersRepo = new RemindersRepository(deps.db);
  const deliveriesRepo = new DeliveriesRepository(deps.db);

  const settings = new SettingsService(deps.db, settingsRepo, remindersRepo);
  const auth = new AuthService(deps.config, deps.db, settingsRepo);
  const proxiesSupported = deps.getRuntimeMeta().capabilities.proxies;
  const proxies = new ProxiesService(proxiesSupported, policy, proxiesRepo, deps.http.request);
  const channels = new ChannelsService(policy, channelsRepo, registry, proxies, settings, proxiesSupported);
  const reminders = new RemindersService(
    deps.db,
    remindersRepo,
    channelsRepo,
    channels,
    registry,
    proxies,
    settings,
  );
  const deliveries = new DeliveriesService(deliveriesRepo, channels, remindersRepo, registry, proxies, settings);
  const scheduler = new CoreScheduler(
    deps.config,
    deps.db,
    remindersRepo,
    deliveriesRepo,
    deliveries,
    settings,
    logger,
  );
  const backup = new BackupService(
    deps.db,
    policy,
    registry,
    settings,
    settingsRepo,
    logger,
    deps.autoBackupStorage,
    scheduler,
  );

  const app = new Hono();

  const trustForwardedProto = deps.trustForwardedProto ?? false;

  const applySessionCookie = (c: Context, token: string) => {
    const secure = auth.resolveCookieSecure(
      c.req.url,
      trustForwardedProto ? c.req.header('x-forwarded-proto') : undefined,
    );
    setCookie(c, SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      secure,
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  };

  const clearSessionCookie = (c: Context) => {
    const secure = auth.resolveCookieSecure(
      c.req.url,
      trustForwardedProto ? c.req.header('x-forwarded-proto') : undefined,
    );
    setCookie(c, SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      secure,
      maxAge: 0,
    });
  };

  const enforceRateLimit = async (c: Context, scope: string): Promise<Response | null> => {
    const ip = deps.getClientIp ? normalizeClientIp(deps.getClientIp(c)) : resolveClientIp(c);
    const result = await deps.rateLimiter.limit(`${scope}:${ip}`);
    if (result.unavailable) {
      return c.json({ error: '限流服务暂不可用，请稍后重试' }, 503);
    }
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds ?? 60));
      return c.json({ error: '尝试次数过多，请 1 分钟后再试' }, 429);
    }
    return null;
  };

  // Global security headers
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'DENY');
  });

  // API auth & no-store cache middleware
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (PUBLIC_API_PATHS.has(c.req.path)) {
      return next();
    }
    if (!(await auth.isInitialized())) {
      return c.json({ error: '系统尚未初始化，请先访问页面完成管理员密码与密钥设置' }, 503);
    }
    const token = auth.extractTokenFromCookieHeader(c.req.header('Cookie'));
    if (!(await auth.verifySessionToken(token))) {
      return c.json({ error: '请先登录' }, 401);
    }
    return next();
  });

  // ---------- System & Health ----------
  app.get('/api/health', async (c) => {
    const [dbOk, heartbeat] = await Promise.all([deps.db.ping(), settings.getCronHeartbeat()]);
    const meta = deps.getRuntimeMeta();
    let schedulerHealthy = true;
    if (meta.schedulerEnabled) {
      if (heartbeat) {
        schedulerHealthy = Date.now() - heartbeat.lastTickAt <= deps.config.healthHeartbeatMaxAgeMs;
      } else if (meta.startedAt) {
        const startedMs = Date.parse(meta.startedAt);
        schedulerHealthy = Date.now() - startedMs <= deps.config.healthHeartbeatMaxAgeMs;
      }
      // On stateless CF Workers before the very first Cron runs, allow healthy=true while dbOk
    }
    const ok = dbOk && schedulerHealthy;
    return c.json(
      {
        data: {
          status: ok ? 'ok' : 'degraded',
          runtime: meta.runtime,
          db: dbOk ? 'ok' : 'error',
          scheduler: {
            enabled: meta.schedulerEnabled,
            lastTickAt: heartbeat ? epochToIso(heartbeat.lastTickAt) : null,
            healthy: schedulerHealthy,
          },
        },
      },
      ok ? 200 : 503,
    );
  });

  app.get('/api/system/status', async (c) => {
    const meta = deps.getRuntimeMeta();
    const [reminderCount, activeReminders, channelCount, retryingDeliveries, heartbeat] = await Promise.all([
      remindersRepo.countActive(),
      remindersRepo.countEnabledActive(),
      channelsRepo.countAll(),
      deliveriesRepo.countRetrying(),
      settings.getCronHeartbeat(),
    ]);
    return c.json({
      data: {
        version: meta.version,
        runtime: meta.runtime,
        runtimeLabel: meta.runtimeLabel,
        startedAt: meta.startedAt,
        uptimeSeconds: meta.uptimeSeconds,
        nodeVersion: meta.runtimeLabel,
        capabilities: meta.capabilities,
        scheduler: {
          enabled: meta.schedulerEnabled,
          paused: meta.schedulerPaused || scheduler.isPaused,
          intervalMs: meta.schedulerIntervalMs,
          lastTickAt: heartbeat ? epochToIso(heartbeat.lastTickAt) : null,
          lastTickDurationMs: heartbeat ? heartbeat.lastTickDurationMs : null,
        },
        counts: {
          reminders: reminderCount,
          activeReminders,
          channels: channelCount,
          retryingDeliveries,
        },
        limits: {
          missedGraceMinutes: deps.config.missedGraceMinutes,
          deliveryRetentionDays: deps.config.deliveryRetentionDays,
        },
        backup: meta.sqliteBackup,
      },
    });
  });

  // ---------- Auth ----------
  app.get('/api/auth/status', async (c) => {
    const initialized = await auth.isInitialized();
    const configurationIssue = await auth.getConfigurationIssue();
    const token = auth.extractTokenFromCookieHeader(c.req.header('Cookie'));
    const authenticated = initialized && (await auth.verifySessionToken(token));
    return c.json({
      data: {
        runtime: deps.config.runtime,
        initialized,
        authenticated,
        configurationIssue,
      },
    });
  });

  app.post('/api/auth/setup', async (c) => {
    const limited = await enforceRateLimit(c, 'auth');
    if (limited) return limited;
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    await auth.setup({
      password: body?.password,
      secret: body?.secret,
      globalTimezone: body?.globalTimezone,
    });
    const token = await auth.createSessionToken();
    applySessionCookie(c, token);
    return c.json({ data: { authenticated: true } });
  });

  app.post('/api/auth/login', async (c) => {
    const limited = await enforceRateLimit(c, 'auth');
    if (limited) return limited;
    if (!(await auth.isInitialized())) {
      return c.json({ error: '系统尚未初始化，请先设置管理密码与系统密钥' }, 503);
    }
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password) {
      throw new ValidationError('请输入管理密码');
    }
    if (!(await auth.verifyPassword(password))) {
      return c.json({ error: '管理密码错误' }, 401);
    }
    const token = await auth.createSessionToken();
    applySessionCookie(c, token);
    return c.json({ data: { authenticated: true } });
  });

  app.post('/api/auth/change-password', async (c) => {
    const limited = await enforceRateLimit(c, 'auth');
    if (limited) return limited;
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    await auth.changePassword(body?.currentPassword, body?.newPassword);
    const token = await auth.createSessionToken();
    applySessionCookie(c, token);
    return c.json({ data: { changed: true } });
  });

  app.post('/api/auth/logout', (c) => {
    clearSessionCookie(c);
    return c.json({ data: null });
  });

  // ---------- Settings ----------
  app.get('/api/settings', async (c) => {
    return c.json({ data: { globalTimezone: await settings.getGlobalTimezone() } });
  });

  app.put('/api/settings', async (c) => {
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    const globalTimezone = await settings.setGlobalTimezone(body?.globalTimezone);
    return c.json({ data: { globalTimezone } });
  });

  // ---------- Proxies ----------
  app.get('/api/proxies', async (c) => c.json({ data: await proxies.list() }));
  app.post('/api/proxies', async (c) => c.json({ data: await proxies.create(await readJsonBody(c)) }, 201));
  app.post('/api/proxies/test', async (c) => c.json({ data: await proxies.testAdhoc(await readJsonBody(c)) }));
  app.put('/api/proxies/:id', async (c) => c.json({ data: await proxies.update(c.req.param('id'), await readJsonBody(c)) }));
  app.delete('/api/proxies/:id', async (c) => c.json({ data: await proxies.delete(c.req.param('id')) }));
  app.post('/api/proxies/:id/test', async (c) => {
    let body: unknown = {};
    try {
      const text = await c.req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      throw new ValidationError('请求体不是有效的 JSON');
    }
    return c.json({ data: await proxies.testSaved(c.req.param('id'), body) });
  });

  // ---------- Channels ----------
  app.get('/api/channels/types', (c) => c.json({ data: channels.listTypes() }));
  app.get('/api/channels', async (c) => c.json({ data: await channels.list() }));
  app.post('/api/channels', async (c) => c.json({ data: await channels.create(await readJsonBody(c)) }, 201));
  app.put('/api/channels/:id', async (c) => c.json({ data: await channels.update(c.req.param('id'), await readJsonBody(c)) }));
  app.delete('/api/channels/:id', async (c) => {
    await channels.delete(c.req.param('id'));
    return c.json({ data: null });
  });
  app.post('/api/channels/:id/test', async (c) => c.json({ data: await channels.test(c.req.param('id')) }));

  // ---------- Reminders ----------
  app.get('/api/reminders', async (c) => {
    const q = c.req.query();
    if (q.page !== undefined || q.pageSize !== undefined) {
      return c.json({ data: await reminders.listPage(q) });
    }
    return c.json({ data: await reminders.list(q) });
  });
  app.post('/api/reminders', async (c) => c.json({ data: await reminders.create(await readJsonBody(c)) }, 201));
  app.post('/api/reminders/batch', async (c) => c.json({ data: await reminders.batch(await readJsonBody(c)) }));
  app.post('/api/reminders/test', async (c) => c.json({ data: await reminders.test(await readJsonBody(c)) }));
  app.get('/api/reminders/:id', async (c) => c.json({ data: await reminders.getById(c.req.param('id')) }));
  app.put('/api/reminders/:id', async (c) => c.json({ data: await reminders.update(c.req.param('id'), await readJsonBody(c)) }));
  app.delete('/api/reminders/:id', async (c) => {
    await reminders.softDelete(c.req.param('id'));
    return c.json({ data: null });
  });
  app.post('/api/reminders/:id/enable', async (c) => c.json({ data: await reminders.enable(c.req.param('id')) }));
  app.post('/api/reminders/:id/disable', async (c) => c.json({ data: await reminders.disable(c.req.param('id')) }));

  // ---------- Deliveries ----------
  app.get('/api/deliveries', async (c) => c.json({ data: await deliveries.listPage(c.req.query()) }));
  app.post('/api/deliveries/:id/retry', async (c) => c.json({ data: await deliveries.manualRetry(c.req.param('id')) }));

  // ---------- Backup ----------
  app.post('/api/backup/export', async (c) => {
    const limited = await enforceRateLimit(c, 'auth');
    if (limited) return limited;
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password || !(await auth.verifyPassword(password))) {
      throw new ValidationError('管理密码错误');
    }
    return c.json({ data: await backup.export() });
  });

  app.post('/api/backup/preview', async (c) => {
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    return c.json({ data: backup.preview(body?.backup) });
  });

  app.post('/api/backup/restore', async (c) => {
    const limited = await enforceRateLimit(c, 'auth');
    if (limited) return limited;
    const body = (await readJsonBody(c)) as Record<string, unknown>;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password || !(await auth.verifyPassword(password))) {
      throw new ValidationError('管理密码错误');
    }
    if (body?.confirmation !== 'RESTORE') {
      throw new ValidationError('请输入 RESTORE 确认覆盖恢复');
    }
    await backup.restore(body?.backup);
    clearSessionCookie(c);
    return c.json({ data: { restored: true } });
  });

  app.get('/api/backup/auto', async (c) => c.json({ data: await backup.getAutoBackupView() }));
  app.put('/api/backup/auto', async (c) => c.json({ data: await backup.updateAutoBackupConfig(await readJsonBody(c)) }));
  app.post('/api/backup/auto/run', async (c) => c.json({ data: await backup.runAutoBackupNow() }));
  app.get('/api/backup/auto/files/:name', async (c) => c.json({ data: await backup.readAutoBackupFile(c.req.param('name')) }));
  app.delete('/api/backup/auto/files/:name', async (c) => c.json({ data: await backup.deleteAutoBackupFile(c.req.param('name')) }));

  // ---------- Error & Not Found ----------
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json({ error: error.message }, error.statusCode as 400 | 401 | 404 | 409 | 413 | 429 | 501 | 503);
    }
    if (error instanceof SyntaxError) {
      return c.json({ error: '请求格式无效' }, 400);
    }
    logger.error({ err: error instanceof Error ? error.message : String(error), path: c.req.path }, 'Unhandled API error');
    return c.json({ error: '服务器处理请求失败' }, 500);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: '接口不存在' }, 404);
    }
    if (deps.fallbackHandler) {
      return deps.fallbackHandler(c);
    }
    return c.json({ error: '资源不存在' }, 404);
  });

  return { app, scheduler, backup, auth, settings, reminders, channels, deliveries, proxies };
}
