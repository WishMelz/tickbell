-- Add 'minute' to reminders.repeat_unit CHECK constraint (SQLite table rebuild)

CREATE TABLE reminders_new (
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
);

INSERT INTO reminders_new (
  id, title, content, content_html, category, tags, timezone,
  starts_at, is_repeating, repeat_every, repeat_unit,
  enabled, completed, next_run_at, schedule_version,
  deleted_at, created_at, updated_at
)
SELECT
  id, title, content, content_html, category, tags, timezone,
  starts_at, is_repeating, repeat_every, repeat_unit,
  enabled, completed, next_run_at, schedule_version,
  deleted_at, created_at, updated_at
FROM reminders;

DROP TABLE reminders;
ALTER TABLE reminders_new RENAME TO reminders;

CREATE INDEX IF NOT EXISTS idx_reminders_due
ON reminders (next_run_at)
WHERE enabled = 1 AND completed = 0 AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reminders_category
ON reminders (category)
WHERE deleted_at IS NULL;
