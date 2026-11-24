import {
  contentHtmlToText,
  epochToLocalInput,
  hashPasswordPbkdf2,
  localDateTimeToEpoch,
  randomHex,
  randomUuid,
  SETTING_AUTH_PASSWORD_HASH,
  SETTING_AUTH_SESSION_SECRET,
  SETTING_GLOBAL_TIMEZONE,
  SETTING_SESSION_GENERATION,
  verifyPasswordPbkdf2,
  type DbAdapter,
  type SqlStatement,
} from '@tickbell/core';

const DEMO_TIMEZONE = 'Asia/Shanghai';

const CH_BARK = '11111111-1111-4111-8111-111111111101';
const CH_TELEGRAM = '11111111-1111-4111-8111-111111111102';
const CH_WECOM = '11111111-1111-4111-8111-111111111103';
const CH_FEISHU = '11111111-1111-4111-8111-111111111104';
const CH_WEBHOOK = '11111111-1111-4111-8111-111111111105';

const REM_STANDUP = '22222222-2222-4222-8222-222222222201';
const REM_WATER = '22222222-2222-4222-8222-222222222202';
const REM_BILL = '22222222-2222-4222-8222-222222222203';
const REM_REVIEW = '22222222-2222-4222-8222-222222222204';
const REM_PROBE = '22222222-2222-4222-8222-222222222205';
const REM_RUN = '22222222-2222-4222-8222-222222222206';
const REM_CERT = '22222222-2222-4222-8222-222222222207';

function dayAtLocal(baseMs: number, offsetDays: number, hhmm: string, tz = DEMO_TIMEZONE): number {
  const shifted = baseMs + offsetDays * 24 * 60 * 60 * 1000;
  const datePart = epochToLocalInput(shifted, tz).slice(0, 10);
  return localDateTimeToEpoch(`${datePart}T${hhmm}`, tz);
}

/**
 * Ensures demo mode always has its preset password hash and a persistent signing secret ready on boot.
 */
export async function ensureDemoAuthInitialized(
  db: DbAdapter,
  demoPassword: string,
  configuredSecret = '',
  now = Date.now(),
): Promise<void> {
  const existingHashRow = await db.first<{ value: string }>({
    sql: 'SELECT value FROM settings WHERE key = ?',
    params: [SETTING_AUTH_PASSWORD_HASH],
  });
  const keepExistingHash =
    existingHashRow?.value && (await verifyPasswordPbkdf2(demoPassword, existingHashRow.value));
  const fallbackSecret = configuredSecret.trim().length >= 16 ? configuredSecret.trim() : randomHex(32);

  const stmts: SqlStatement[] = [];
  if (!keepExistingHash) {
    const passwordHash = await hashPasswordPbkdf2(demoPassword);
    stmts.push({
      sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      params: [SETTING_AUTH_PASSWORD_HASH, passwordHash, now],
    });
  }
  stmts.push(
    {
      sql: `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
      params: [SETTING_AUTH_SESSION_SECRET, fallbackSecret, now],
    },
    {
      sql: `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
      params: [SETTING_SESSION_GENERATION, randomUuid(), now],
    },
    {
      sql: `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
      params: [SETTING_GLOBAL_TIMEZONE, DEMO_TIMEZONE, now],
    },
  );
  await db.batch(stmts);
}

export async function isDemoDatabaseEmpty(db: DbAdapter): Promise<boolean> {
  const [remRow, chRow] = await Promise.all([
    db.first<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM reminders' }),
    db.first<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM channels' }),
  ]);
  return Number(remRow?.count ?? 0) === 0 && Number(chRow?.count ?? 0) === 0;
}

/**
 * Atomically wipes business tables and restores curated demo channels, reminders (single/repeat/rich-text),
 * and delivery logs relative to `now`, while preserving demo login credentials.
 */
export async function resetDemoData(db: DbAdapter, now = Date.now()): Promise<void> {
  const createdBase = now - 3 * 24 * 60 * 60 * 1000;

  const standupHtml =
    '<p><strong>今日晨会核对清单：</strong></p><ul><li>同步昨日核心进展与阻塞项</li><li>确认今日 <em>P0</em> 发布排期与验收人</li><li>会后更新看板状态</li></ul>';
  const reviewHtml =
    '<p>演示环境每日凌晨 <strong>03:00</strong> 自动重置数据，你可以自由体验创建、编辑、筛选与<strong>测试发送</strong>功能。</p><blockquote><p>提示：填写你自己的公网渠道地址即可真实收到测试推送。</p></blockquote><p>项目仓库：<a href="https://github.com/WishMelz/tickbell" target="_blank" rel="noopener noreferrer">https://github.com/WishMelz/tickbell</a></p>';

  const channels = [
    {
      id: CH_BARK,
      name: '示例 Bark（iOS 推送）',
      type: 'bark',
      enabled: 1,
      config: JSON.stringify({
        serverUrl: 'https://api.day.app',
        deviceKey: 'demo-device-key-replace-me',
        group: 'TickBell',
        level: 'active',
        isArchive: true,
      }),
    },
    {
      id: CH_TELEGRAM,
      name: '示例 Telegram Bot',
      type: 'telegram',
      enabled: 1,
      config: JSON.stringify({
        botToken: '123456789:DEMO_BOT_TOKEN_REPLACE_ME',
        chatId: '-1001234567890',
        parseMode: 'HTML',
        disableNotification: false,
        protectContent: false,
      }),
    },
    {
      id: CH_WECOM,
      name: '示例企业微信机器人',
      type: 'wecom',
      enabled: 1,
      config: JSON.stringify({
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo-wecom-key',
        msgType: 'markdown',
        mentionAll: false,
      }),
    },
    {
      id: CH_FEISHU,
      name: '示例飞书群机器人',
      type: 'feishu',
      enabled: 1,
      config: JSON.stringify({
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-feishu-key',
        msgType: 'interactive',
        mentionAll: false,
      }),
    },
    {
      id: CH_WEBHOOK,
      name: '示例通用 Webhook',
      type: 'webhook',
      enabled: 1,
      config: JSON.stringify({
        url: 'https://example.com/webhooks/tickbell-demo',
        method: 'POST',
      }),
    },
  ];

  const standupNext = dayAtLocal(now, 1, '09:30');
  const waterNext = Math.ceil((now + 20 * 60_000) / (60_000)) * 60_000;
  const billNext = dayAtLocal(now, 5, '10:00');
  const reviewNext = dayAtLocal(now, 1, '15:00');
  const probeNext = Math.ceil((now + 10 * 60_000) / (60_000)) * 60_000;
  const runNext = dayAtLocal(now, 2, '08:00');
  const certDone = dayAtLocal(now, -1, '11:00');

  const reminders = [
    {
      id: REM_STANDUP,
      title: '每日晨会与待办梳理',
      content: contentHtmlToText(standupHtml),
      content_html: standupHtml,
      category: '工作',
      tags: JSON.stringify(['重要', '每日']),
      timezone: null,
      starts_at: standupNext,
      is_repeating: 1,
      repeat_every: 1,
      repeat_unit: 'day',
      enabled: 1,
      completed: 0,
      next_run_at: standupNext,
      channels: [CH_BARK, CH_WECOM],
    },
    {
      id: REM_WATER,
      title: '久坐起身喝水与远眺',
      content: '离开屏幕休息 2 分钟，喝一杯温水并活动肩颈。',
      content_html: null,
      category: '健康',
      tags: JSON.stringify(['护眼', '日常']),
      timezone: null,
      starts_at: waterNext,
      is_repeating: 1,
      repeat_every: 2,
      repeat_unit: 'hour',
      enabled: 1,
      completed: 0,
      next_run_at: waterNext,
      channels: [CH_BARK],
    },
    {
      id: REM_BILL,
      title: '信用卡账单与固定支出核对',
      content: '核对本月信用卡账单、云服务续费与水电燃气扣款，避免逾期。',
      content_html: null,
      category: '生活',
      tags: JSON.stringify(['财务', '重要']),
      timezone: null,
      starts_at: billNext,
      is_repeating: 1,
      repeat_every: 1,
      repeat_unit: 'month',
      enabled: 1,
      completed: 0,
      next_run_at: billNext,
      channels: [CH_BARK, CH_TELEGRAM],
    },
    {
      id: REM_REVIEW,
      title: 'TickBell 2.0 演示功能体验与反馈',
      content: contentHtmlToText(reviewHtml),
      content_html: reviewHtml,
      category: '工作',
      tags: JSON.stringify(['团队', '演示']),
      timezone: null,
      starts_at: reviewNext,
      is_repeating: 0,
      repeat_every: null,
      repeat_unit: null,
      enabled: 1,
      completed: 0,
      next_run_at: reviewNext,
      channels: [CH_FEISHU, CH_WEBHOOK],
    },
    {
      id: REM_PROBE,
      title: '服务探针与证书健康巡检（UTC）',
      content: '演示独立时区提醒：按 UTC 时间每 30 分钟触发一次健康检查通知。',
      content_html: null,
      category: '运维',
      tags: JSON.stringify(['监控', '自动化']),
      timezone: 'UTC',
      starts_at: probeNext,
      is_repeating: 1,
      repeat_every: 30,
      repeat_unit: 'minute',
      enabled: 1,
      completed: 0,
      next_run_at: probeNext,
      channels: [CH_FEISHU, CH_WEBHOOK],
    },
    {
      id: REM_RUN,
      title: '周末户外 5 公里跑步打卡',
      content: '热身 10 分钟，注意配速与补水（示例已暂停状态）。',
      content_html: null,
      category: '生活',
      tags: JSON.stringify(['健身']),
      timezone: null,
      starts_at: runNext,
      is_repeating: 1,
      repeat_every: 7,
      repeat_unit: 'day',
      enabled: 0,
      completed: 0,
      next_run_at: runNext,
      channels: [CH_BARK],
    },
    {
      id: REM_CERT,
      title: '主站域名与 SSL 证书续期确认',
      content: '已确认 HTTPS 自动续期生效（示例已完成单次提醒）。',
      content_html: null,
      category: '运维',
      tags: JSON.stringify(['安全']),
      timezone: null,
      starts_at: certDone,
      is_repeating: 0,
      repeat_every: null,
      repeat_unit: null,
      enabled: 0,
      completed: 1,
      next_run_at: certDone,
      channels: [CH_TELEGRAM, CH_WECOM],
    },
  ];

  const deliveries = [
    {
      id: '33333333-3333-4333-8333-333333333301',
      event_id: '44444444-4444-4444-8444-444444444401',
      reminder_id: REM_STANDUP,
      scheduled_at: now - 3 * 60 * 60 * 1000,
      channel_id: CH_BARK,
      status: 'sent',
      attempts: 1,
      next_retry_at: null,
      http_status: 200,
      error: null,
      response_summary: '{"code":200,"message":"success"}',
      sent_at: now - 3 * 60 * 60 * 1000 + 420,
      created_at: now - 3 * 60 * 60 * 1000,
    },
    {
      id: '33333333-3333-4333-8333-333333333302',
      event_id: '44444444-4444-4444-8444-444444444402',
      reminder_id: REM_STANDUP,
      scheduled_at: now - 3 * 60 * 60 * 1000,
      channel_id: CH_WECOM,
      status: 'sent',
      attempts: 1,
      next_retry_at: null,
      http_status: 200,
      error: null,
      response_summary: '{"errcode":0,"errmsg":"ok"}',
      sent_at: now - 3 * 60 * 60 * 1000 + 610,
      created_at: now - 3 * 60 * 60 * 1000,
    },
    {
      id: '33333333-3333-4333-8333-333333333303',
      event_id: '44444444-4444-4444-8444-444444444403',
      reminder_id: REM_WATER,
      scheduled_at: now - 2 * 60 * 60 * 1000,
      channel_id: CH_BARK,
      status: 'sent',
      attempts: 1,
      next_retry_at: null,
      http_status: 200,
      error: null,
      response_summary: '{"code":200,"message":"success"}',
      sent_at: now - 2 * 60 * 60 * 1000 + 310,
      created_at: now - 2 * 60 * 60 * 1000,
    },
    {
      id: '33333333-3333-4333-8333-333333333304',
      event_id: '44444444-4444-4444-8444-444444444404',
      reminder_id: REM_PROBE,
      scheduled_at: now - 90 * 60 * 1000,
      channel_id: CH_FEISHU,
      status: 'sent',
      attempts: 1,
      next_retry_at: null,
      http_status: 200,
      error: null,
      response_summary: '{"code":0,"msg":"success"}',
      sent_at: now - 90 * 60 * 1000 + 530,
      created_at: now - 90 * 60 * 1000,
    },
    {
      id: '33333333-3333-4333-8333-333333333305',
      event_id: '44444444-4444-4444-8444-444444444405',
      reminder_id: REM_PROBE,
      scheduled_at: now - 60 * 60 * 1000,
      channel_id: CH_WEBHOOK,
      status: 'retrying',
      attempts: 1,
      next_retry_at: now + 5 * 60 * 1000,
      http_status: 503,
      error: '目标 Webhook 暂时不可用（HTTP 503），演示自动退避重试状态',
      response_summary: 'Service Unavailable',
      sent_at: null,
      created_at: now - 60 * 60 * 1000,
    },
    {
      id: '33333333-3333-4333-8333-333333333306',
      event_id: '44444444-4444-4444-8444-444444444406',
      reminder_id: REM_CERT,
      scheduled_at: certDone,
      channel_id: CH_TELEGRAM,
      status: 'failed',
      attempts: 1,
      next_retry_at: null,
      http_status: 401,
      error: '示例失败日志：Bot Token 无效（HTTP 401），已停止重试',
      response_summary: '{"ok":false,"error_code":401,"description":"Unauthorized"}',
      sent_at: null,
      created_at: certDone,
    },
    {
      id: '33333333-3333-4333-8333-333333333307',
      event_id: '44444444-4444-4444-8444-444444444407',
      reminder_id: REM_RUN,
      scheduled_at: now - 24 * 60 * 60 * 1000,
      channel_id: CH_BARK,
      status: 'skipped',
      attempts: 0,
      next_retry_at: null,
      http_status: null,
      error: '超出错过提醒宽限窗口（60 分钟），已跳过（演示跳过状态）',
      response_summary: null,
      sent_at: null,
      created_at: now - 23 * 60 * 60 * 1000,
    },
  ];

  const stmts: SqlStatement[] = [
    { sql: 'DELETE FROM deliveries' },
    { sql: 'DELETE FROM delivery_receipts' },
    { sql: 'DELETE FROM reminder_channels' },
    { sql: 'DELETE FROM reminders' },
    { sql: 'DELETE FROM channels' },
    { sql: 'DELETE FROM proxies' },
    {
      sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      params: [SETTING_GLOBAL_TIMEZONE, DEMO_TIMEZONE, now],
    },
  ];

  for (const ch of channels) {
    stmts.push({
      sql: `INSERT INTO channels (id, name, type, enabled, config, proxy_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      params: [ch.id, ch.name, ch.type, ch.enabled, ch.config, createdBase, now],
    });
  }

  for (const r of reminders) {
    stmts.push({
      sql: `INSERT INTO reminders (
              id, title, content, content_html, category, tags, timezone,
              starts_at, is_repeating, repeat_every, repeat_unit,
              enabled, completed, next_run_at, schedule_version, deleted_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      params: [
        r.id,
        r.title,
        r.content,
        r.content_html,
        r.category,
        r.tags,
        r.timezone,
        r.starts_at,
        r.is_repeating,
        r.repeat_every,
        r.repeat_unit,
        r.enabled,
        r.completed,
        r.next_run_at,
        createdBase,
        now,
      ],
    });
    for (const cid of r.channels) {
      stmts.push({
        sql: `INSERT INTO reminder_channels (reminder_id, channel_id) VALUES (?, ?)`,
        params: [r.id, cid],
      });
    }
  }

  for (const d of deliveries) {
    stmts.push({
      sql: `INSERT INTO deliveries (
              id, event_id, reminder_id, scheduled_at, channel_id, status,
              attempts, next_retry_at, http_status, error, response_summary,
              sent_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        d.id,
        d.event_id,
        d.reminder_id,
        d.scheduled_at,
        d.channel_id,
        d.status,
        d.attempts,
        d.next_retry_at,
        d.http_status,
        d.error,
        d.response_summary,
        d.sent_at,
        d.created_at,
        d.created_at,
      ],
    });
    stmts.push({
      sql: `INSERT OR IGNORE INTO delivery_receipts (reminder_id, scheduled_at, channel_id) VALUES (?, ?, ?)`,
      params: [d.reminder_id, d.scheduled_at, d.channel_id],
    });
  }

  await db.batch(stmts);
}
