-- Add reusable outbound network proxies and optional channel -> proxy binding

CREATE TABLE IF NOT EXISTS proxies (
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
);

ALTER TABLE channels ADD COLUMN proxy_id TEXT REFERENCES proxies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_channels_proxy ON channels (proxy_id);
