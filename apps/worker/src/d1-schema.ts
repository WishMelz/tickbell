import type { D1Database } from '@cloudflare/workers-types';

const REQUIRED_TABLES = [
  'settings',
  'proxies',
  'channels',
  'reminders',
  'reminder_channels',
  'deliveries',
  'delivery_receipts',
] as const;

/**
 * Idempotent Cloudflare D1 baseline schema, kept in lockstep with `migrations/d1/0001_init.sql`
 * (verified by `apps/worker/test/worker.test.ts`).
 *
 * Allows zero-config Cloudflare Deploy Button and direct Git repository imports (`npx wrangler deploy`)
 * where Wrangler auto-provisions an empty D1 database without executing CLI migration scripts.
 */
export const D1_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES
  ('global_timezone', 'UTC', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('session_generation', '', CAST(strftime('%s', 'now') AS INTEGER) * 1000)`,
  `CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  protocol TEXT NOT NULL CHECK (protocol IN ('http', 'https', 'socks5')),
  host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 255),
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username TEXT NOT NULL DEFAULT '' CHECK (length(username) <= 128),
  password TEXT NOT NULL DEFAULT '' CHECK (length(password) <= 256),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  config TEXT CHECK (config IS NULL OR json_valid(config)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  proxy_id TEXT REFERENCES proxies(id) ON DELETE SET NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_channels_type ON channels (type, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_channels_proxy ON channels (proxy_id)`,
  `CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  content TEXT NOT NULL DEFAULT '' CHECK (length(content) <= 4000),
  content_html TEXT,
  category TEXT NOT NULL DEFAULT '' CHECK (length(category) <= 80),
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  timezone TEXT,
  starts_at INTEGER NOT NULL,
  is_repeating INTEGER NOT NULL DEFAULT 0 CHECK (is_repeating IN (0, 1)),
  repeat_every INTEGER CHECK (repeat_every IS NULL OR repeat_every BETWEEN 1 AND 9999),
  repeat_unit TEXT CHECK (repeat_unit IS NULL OR repeat_unit IN ('minute', 'hour', 'day', 'month', 'year')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  next_run_at INTEGER NOT NULL,
  schedule_version INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (is_repeating = 0 AND repeat_every IS NULL AND repeat_unit IS NULL)
    OR
    (is_repeating = 1 AND repeat_every IS NOT NULL AND repeat_unit IS NOT NULL)
  )
)`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_due
ON reminders (next_run_at)
WHERE enabled = 1 AND completed = 0 AND deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_category
ON reminders (category)
WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_list
ON reminders (next_run_at)
WHERE deleted_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS reminder_channels (
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  PRIMARY KEY (reminder_id, channel_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_reminder_channels_channel ON reminder_channels (channel_id)`,
  `CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  reminder_id TEXT NOT NULL REFERENCES reminders(id),
  scheduled_at INTEGER NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'retrying', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  http_status INTEGER,
  error TEXT,
  response_summary TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (reminder_id, scheduled_at, channel_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_created_at ON deliveries (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_reminder ON deliveries (reminder_id, scheduled_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_retry ON deliveries (next_retry_at) WHERE status = 'retrying'`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON deliveries (updated_at) WHERE status = 'pending'`,
  `CREATE TABLE IF NOT EXISTS delivery_receipts (
  reminder_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (reminder_id, scheduled_at, channel_id)
)`,
];

let schemaReady = false;
let inflight: Promise<void> | null = null;

export function resetD1SchemaCache(): void {
  schemaReady = false;
  inflight = null;
}

/**
 * Ensures the D1 schema exists once per Worker isolate.
 * - Warm isolate: returns immediately (0 queries).
 * - Cold start on existing DB: 1 lightweight `sqlite_master` check (0 writes).
 * - First boot on freshly provisioned empty D1: 1 atomic `db.batch()` creates all tables & indexes.
 */
export async function ensureD1Schema(db: D1Database | undefined): Promise<void> {
  if (!db) {
    throw new Error('Cloudflare D1 binding "DB" is missing');
  }
  if (schemaReady) return;
  if (inflight) return inflight;

  inflight = (async () => {
    const placeholders = REQUIRED_TABLES.map(() => '?').join(', ');
    const check = await db
      .prepare(`SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
      .bind(...REQUIRED_TABLES)
      .first<{ cnt: number }>();

    if (Number(check?.cnt ?? 0) < REQUIRED_TABLES.length) {
      const statements = D1_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql));
      try {
        await db.batch(statements);
      } catch {
        // Fallback: if batch DDL fails on a specific D1 runtime edge case, run statements sequentially.
        for (const sql of D1_SCHEMA_STATEMENTS) {
          await db.prepare(sql).run();
        }
      }
    }
    schemaReady = true;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}
