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

const CH_BARK_OFFICIAL = '11111111-1111-4111-8111-111111111101';
const CH_BARK_BACKUP = '11111111-1111-4111-8111-111111111102';
const CH_TELEGRAM = '11111111-1111-4111-8111-111111111103';
const CH_WECOM = '11111111-1111-4111-8111-111111111104';
const CH_FEISHU = '11111111-1111-4111-8111-111111111105';

const REM_GPT = '22222222-2222-4222-8222-222222222201';
const REM_O2 = '22222222-2222-4222-8222-222222222202';
const REM_GV = '22222222-2222-4222-8222-222222222203';
const REM_LEBARA = '22222222-2222-4222-8222-222222222204';
const REM_VOXI = '22222222-2222-4222-8222-222222222205';
const REM_A1 = '22222222-2222-4222-8222-222222222206';
const REM_DIALOG = '22222222-2222-4222-8222-222222222207';
const REM_AIS = '22222222-2222-4222-8222-222222222208';
const REM_CSL = '22222222-2222-4222-8222-222222222209';
const REM_RN = '22222222-2222-4222-8222-222222222210';
const REM_DMIT = '22222222-2222-4222-8222-222222222211';
const REM_BWG = '22222222-2222-4222-8222-222222222212';
const REM_SAILY = '22222222-2222-4222-8222-222222222213';
const REM_DOMAIN = '22222222-2222-4222-8222-222222222214';

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
 * Atomically wipes business tables and restores curated, anonymized demo data
 * (overseas eSIM/SIM keep-alive, VPS renewal, AI subscription reminders, channels & delivery logs)
 * relative to `now`, while preserving demo login credentials.
 */
export async function resetDemoData(db: DbAdapter, now = Date.now()): Promise<void> {
  const createdBase = now - 5 * 24 * 60 * 60 * 1000;

  const gptHtml =
    '<p><strong>每月 12 号自动续费</strong>，提前检查 Apple ID 土区礼品卡余额是否充足。</p>';
  const lebaraHtml =
    '<p>示例号码：<strong>+44 7700 900123</strong></p><p>每 90 天发送一条短信或产生一次余额变动以保号。</p>';
  const a1Html =
    '<p>首次激活后有效期：<strong>180 天</strong>；到期后有 270 天宽限期（期间仍可接收短信）。</p><p>宽限期内在线充值最低 <strong>€2</strong>，可恢复账户有效期 92 天。</p><p>在线充值：<a href="https://www.a1.hr/kupi-bon" target="_blank" rel="noopener noreferrer">https://www.a1.hr/kupi-bon</a></p>';
  const dialogHtml =
    '<p>示例号码：<strong>+94 77 000 0123</strong></p><ul><li>Rs. 50 Dial Charger：15 天</li><li>Rs. 100 Dial Charger：30 天（1 个月）</li><li>Rs. 400 Dial Charger：6 个月</li><li>Rs. 1,000 Dial Charger：1 年</li></ul><p>充值链接：<a href="https://dialog.lk/reload-and-pay" target="_blank" rel="noopener noreferrer">https://dialog.lk/reload-and-pay</a></p>';
  const rnHtml =
    '<p><strong>2.5 GB KVM VPS</strong>（Black Friday 特惠款）</p><p>续费账号：demo@example.com · 核查账单与自动续费状态</p>';

  const channels = [
    {
      id: CH_BARK_OFFICIAL,
      name: 'Bark-官方',
      type: 'bark',
      enabled: 1,
      config: JSON.stringify({
        serverUrl: 'https://api.day.app',
        deviceKey: 'demo-bark-official-key',
        group: 'TickBell',
        level: 'active',
        isArchive: true,
      }),
    },
    {
      id: CH_BARK_BACKUP,
      name: 'Bark-备用',
      type: 'bark',
      enabled: 1,
      config: JSON.stringify({
        serverUrl: 'https://api.day.app',
        deviceKey: 'demo-bark-backup-key',
        group: '保号与续费',
        level: 'timeSensitive',
        isArchive: true,
      }),
    },
    {
      id: CH_TELEGRAM,
      name: 'Telegram 通知机器人',
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
      name: '企业微信机器人',
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
      name: '飞书群机器人',
      type: 'feishu',
      enabled: 1,
      config: JSON.stringify({
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo-feishu-key',
        msgType: 'interactive',
        mentionAll: false,
      }),
    },
  ];

  const gptNext = dayAtLocal(now, 3, '15:30');
  const o2Next = dayAtLocal(now, 12, '15:00');
  const gvNext = dayAtLocal(now, 26, '15:45');
  const lebaraNext = dayAtLocal(now, 45, '15:00');
  const voxiNext = dayAtLocal(now, 72, '15:40');
  const a1Next = dayAtLocal(now, 96, '15:40');
  const rnNext = dayAtLocal(now, 118, '07:00', 'UTC');
  const bwgNext = dayAtLocal(now, 140, '15:30');
  const dialogNext = dayAtLocal(now, 165, '15:55');
  const dmitNext = dayAtLocal(now, 210, '15:30');
  const aisNext = dayAtLocal(now, 240, '15:00');
  const sailyNext = dayAtLocal(now, 260, '15:35');
  const cslNext = dayAtLocal(now, 295, '15:05');
  const domainDone = dayAtLocal(now, -2, '15:30');

  const reminders = [
    {
      id: REM_GPT,
      title: 'GPT 订阅续费（Apple 土区）',
      content: contentHtmlToText(gptHtml),
      content_html: gptHtml,
      category: '订阅',
      tags: JSON.stringify(['AI', '续费']),
      timezone: null,
      starts_at: gptNext,
      is_repeating: 1,
      repeat_every: 1,
      repeat_unit: 'month',
      enabled: 1,
      completed: 0,
      next_run_at: gptNext,
      channels: [CH_BARK_OFFICIAL, CH_BARK_BACKUP],
    },
    {
      id: REM_O2,
      title: '德国 O2 eSIM 保号',
      content: 'Wise 定时转账，核查是否已自动到账并顺延有效期。',
      content_html: null,
      category: 'eSIM',
      tags: JSON.stringify(['电话卡', '保号']),
      timezone: null,
      starts_at: o2Next,
      is_repeating: 1,
      repeat_every: 3,
      repeat_unit: 'month',
      enabled: 1,
      completed: 0,
      next_run_at: o2Next,
      channels: [CH_BARK_OFFICIAL, CH_BARK_BACKUP],
    },
    {
      id: REM_GV,
      title: 'Google Voice 保号活跃',
      content: '每 3 个月主动发一条短信或拨出一次语音，避免号码回收。',
      content_html: null,
      category: 'GV',
      tags: JSON.stringify(['电话卡', '保号']),
      timezone: null,
      starts_at: gvNext,
      is_repeating: 1,
      repeat_every: 80,
      repeat_unit: 'day',
      enabled: 1,
      completed: 0,
      next_run_at: gvNext,
      channels: [CH_BARK_OFFICIAL, CH_TELEGRAM],
    },
    {
      id: REM_LEBARA,
      title: '英国 Lebara eSIM 保号',
      content: contentHtmlToText(lebaraHtml),
      content_html: lebaraHtml,
      category: 'eSIM',
      tags: JSON.stringify(['电话卡', '保号']),
      timezone: null,
      starts_at: lebaraNext,
      is_repeating: 1,
      repeat_every: 85,
      repeat_unit: 'day',
      enabled: 1,
      completed: 0,
      next_run_at: lebaraNext,
      channels: [CH_BARK_OFFICIAL, CH_BARK_BACKUP],
    },
    {
      id: REM_VOXI,
      title: '英国 VOXI 保号',
      content: '每 180 天内主动发送一次短信保持账户活跃。',
      content_html: null,
      category: 'eSIM',
      tags: JSON.stringify(['电话卡', '保号']),
      timezone: null,
      starts_at: voxiNext,
      is_repeating: 1,
      repeat_every: 170,
      repeat_unit: 'day',
      enabled: 1,
      completed: 0,
      next_run_at: voxiNext,
      channels: [CH_BARK_OFFICIAL],
    },
    {
      id: REM_A1,
      title: '克罗地亚 A1 eSIM 充值保号',
      content: contentHtmlToText(a1Html),
      content_html: a1Html,
      category: 'eSIM',
      tags: JSON.stringify(['电话卡', '保号']),
      timezone: null,
      starts_at: a1Next,
      is_repeating: 1,
      repeat_every: 90,
      repeat_unit: 'day',
      enabled: 1,
      completed: 0,
      next_run_at: a1Next,
      channels: [CH_BARK_OFFICIAL, CH_BARK_BACKUP, CH_TELEGRAM],
    },
    {
      id: REM_RN,
      title: 'RackNerd 服务器年付续费（UTC）',
      content: contentHtmlToText(rnHtml),
      content_html: rnHtml,
      category: 'VPS',
      tags: JSON.stringify(['VPS', '续费']),
      timezone: 'UTC',
      starts_at: rnNext,
      is_repeating: 1,
      repeat_every: 1,
      repeat_unit: 'year',
      enabled: 1,
      completed: 0,
      next_run_at: rnNext,
      channels: [CH_BARK_OFFICIAL, CH_FEISHU],
    },
    {
      id: REM_BWG,
      title: '搬瓦工服务器续费',
      content: '核查年度账单与续费优惠码（示例已暂停状态）。',
      content_html: null,
      category: 'VPS',
      tags: JSON.stringify(['搬瓦工', 'VPS', '续费']),
      timezone: null,
      starts_at: bwgNext,
      is_repeating: 1,
      repeat_every: 1,
      repeat_unit: 'year',
      enabled: 0,
      completed: 0,
      next_run_at: bwgNext,
      channels: [CH_BARK_OFFICIAL, CH_BARK_BACKUP],
    },
    {
      id: REM_DIALOG,
      title: '斯里兰卡 Dialog eSIM 充值',
      content: contentHtmlToText(dialogHtml),
      content_html: dialogHtml,
      category: 'eSIM',
      tags: JSON.stringify(['电话卡', '保号']),
      timezone: null,
      starts_at: dialogNext,
      is_repeating: 1,
      repeat_every: 4,
      repeat_unit: 'month',
      enabled: 1,
      completed: 0,
      next_run_at: dialogNext,
      channels: [CH_BARK_OFFICIAL, CH_BARK_BACKUP],
    },
    {
      id: REM_DMIT,
      title: 'DMIT Pro 节点续费',
      content: '检查主用节点年度续费账单与流量重置时间。',
      content_html: null,
      category: 'VPS',
      tags: JSON.stringify(['DMIT', 'VPS', '续费']),
      timezone: null,
      starts_at: dmitNext,
      is_repeating: 1,
      repeat_every: 1,
      repeat_unit: 'year',
      enabled: 1,
      completed: 0,
      next_run_at: dmitNext,
      channels: [CH_BARK_OFFICIAL, CH_TELEGRAM, CH_FEISHU],
    },
    {
      id: REM_AIS,
      title: '泰国 AIS eSIM 续期',
      content: 'myAIS 续费 365 天 49 泰铢保号套餐。',
      content_html: null,
      category: 'eSIM',
      tags: JSON.stringify(['电话卡', '保号']),
      timezone: null,
      starts_at: aisNext,
      is_repeating: 1,
      repeat_every: 350,
      repeat_unit: 'day',
      enabled: 1,
      completed: 0,
      next_run_at: aisNext,
      channels: [CH_BARK_OFFICIAL],
    },
    {
      id: REM_SAILY,
      title: '美国 Saily 年费流量包到期',
      content: '打开 App 核对剩余流量与到期时间（单次提醒示例）。',
      content_html: null,
      category: 'eSIM',
      tags: JSON.stringify(['电话卡', '续费']),
      timezone: null,
      starts_at: sailyNext,
      is_repeating: 0,
      repeat_every: null,
      repeat_unit: null,
      enabled: 1,
      completed: 0,
      next_run_at: sailyNext,
      channels: [CH_BARK_OFFICIAL],
    },
    {
      id: REM_CSL,
      title: '香港 CSL 电话卡延期',
      content: 'App 内充值 HK$20 顺延有效期 365 天。',
      content_html: null,
      category: 'Sim卡',
      tags: JSON.stringify(['电话卡', '保号']),
      timezone: null,
      starts_at: cslNext,
      is_repeating: 1,
      repeat_every: 11,
      repeat_unit: 'month',
      enabled: 1,
      completed: 0,
      next_run_at: cslNext,
      channels: [CH_BARK_OFFICIAL, CH_WECOM],
    },
    {
      id: REM_DOMAIN,
      title: '主站域名与 SSL 证书续期确认',
      content: '已核查域名自动续费与 HTTPS 证书有效（已完成示例）。',
      content_html: null,
      category: 'VPS',
      tags: JSON.stringify(['安全', '续费']),
      timezone: null,
      starts_at: domainDone,
      is_repeating: 0,
      repeat_every: null,
      repeat_unit: null,
      enabled: 0,
      completed: 1,
      next_run_at: domainDone,
      channels: [CH_WECOM, CH_FEISHU],
    },
  ];

  const deliveries = [
    {
      id: '33333333-3333-4333-8333-333333333301',
      event_id: '44444444-4444-4444-8444-444444444401',
      reminder_id: REM_GPT,
      scheduled_at: now - 3 * 60 * 60 * 1000,
      channel_id: CH_BARK_OFFICIAL,
      status: 'sent',
      attempts: 1,
      next_retry_at: null,
      http_status: 200,
      error: null,
      response_summary: '{"code":200,"message":"success"}',
      sent_at: now - 3 * 60 * 60 * 1000 + 380,
      created_at: now - 3 * 60 * 60 * 1000,
    },
    {
      id: '33333333-3333-4333-8333-333333333302',
      event_id: '44444444-4444-4444-8444-444444444402',
      reminder_id: REM_GPT,
      scheduled_at: now - 3 * 60 * 60 * 1000,
      channel_id: CH_BARK_BACKUP,
      status: 'sent',
      attempts: 1,
      next_retry_at: null,
      http_status: 200,
      error: null,
      response_summary: '{"code":200,"message":"success"}',
      sent_at: now - 3 * 60 * 60 * 1000 + 460,
      created_at: now - 3 * 60 * 60 * 1000,
    },
    {
      id: '33333333-3333-4333-8333-333333333303',
      event_id: '44444444-4444-4444-8444-444444444403',
      reminder_id: REM_O2,
      scheduled_at: now - 6 * 60 * 60 * 1000,
      channel_id: CH_BARK_OFFICIAL,
      status: 'sent',
      attempts: 1,
      next_retry_at: null,
      http_status: 200,
      error: null,
      response_summary: '{"code":200,"message":"success"}',
      sent_at: now - 6 * 60 * 60 * 1000 + 290,
      created_at: now - 6 * 60 * 60 * 1000,
    },
    {
      id: '33333333-3333-4333-8333-333333333304',
      event_id: '44444444-4444-4444-8444-444444444404',
      reminder_id: REM_DMIT,
      scheduled_at: now - 12 * 60 * 60 * 1000,
      channel_id: CH_FEISHU,
      status: 'sent',
      attempts: 1,
      next_retry_at: null,
      http_status: 200,
      error: null,
      response_summary: '{"code":0,"msg":"success"}',
      sent_at: now - 12 * 60 * 60 * 1000 + 510,
      created_at: now - 12 * 60 * 60 * 1000,
    },
    {
      id: '33333333-3333-4333-8333-333333333305',
      event_id: '44444444-4444-4444-8444-444444444405',
      reminder_id: REM_CSL,
      scheduled_at: now - 18 * 60 * 60 * 1000,
      channel_id: CH_WECOM,
      status: 'sent',
      attempts: 1,
      next_retry_at: null,
      http_status: 200,
      error: null,
      response_summary: '{"errcode":0,"errmsg":"ok"}',
      sent_at: now - 18 * 60 * 60 * 1000 + 420,
      created_at: now - 18 * 60 * 60 * 1000,
    },
    {
      id: '33333333-3333-4333-8333-333333333306',
      event_id: '44444444-4444-4444-8444-444444444406',
      reminder_id: REM_A1,
      scheduled_at: now - 24 * 60 * 60 * 1000,
      channel_id: CH_TELEGRAM,
      status: 'retrying',
      attempts: 1,
      next_retry_at: now + 5 * 60 * 1000,
      http_status: 429,
      error: 'Telegram 接口触发频控（HTTP 429），演示自动退避重试状态',
      response_summary: '{"ok":false,"error_code":429,"description":"Too Many Requests"}',
      sent_at: null,
      created_at: now - 24 * 60 * 60 * 1000,
    },
    {
      id: '33333333-3333-4333-8333-333333333307',
      event_id: '44444444-4444-4444-8444-444444444407',
      reminder_id: REM_DOMAIN,
      scheduled_at: domainDone,
      channel_id: CH_WECOM,
      status: 'failed',
      attempts: 1,
      next_retry_at: null,
      http_status: 401,
      error: '示例失败日志：机器人 Webhook Key 无效（HTTP 401），已停止重试',
      response_summary: '{"errcode":93000,"errmsg":"invalid webhook url"}',
      sent_at: null,
      created_at: domainDone,
    },
    {
      id: '33333333-3333-4333-8333-333333333308',
      event_id: '44444444-4444-4444-8444-444444444408',
      reminder_id: REM_BWG,
      scheduled_at: now - 36 * 60 * 60 * 1000,
      channel_id: CH_BARK_OFFICIAL,
      status: 'skipped',
      attempts: 0,
      next_retry_at: null,
      http_status: null,
      error: '超出错过提醒宽限窗口（60 分钟），已跳过（演示跳过状态）',
      response_summary: null,
      sent_at: null,
      created_at: now - 35 * 60 * 60 * 1000,
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
