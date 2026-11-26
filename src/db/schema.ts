// Database schema. Plain, portable SQL (works on SQLite; trivially adapted to PostgreSQL).
// Timestamps are milliseconds since epoch (INTEGER / BIGINT).

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       TEXT NOT NULL UNIQUE,
  settings_json TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network    TEXT NOT NULL,
  address    TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, network, address)
);

CREATE TABLE IF NOT EXISTS alert_states (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network    TEXT NOT NULL,
  address    TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, network, address)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  network              TEXT NOT NULL,
  address              TEXT NOT NULL,
  at                   INTEGER NOT NULL,
  status               TEXT NOT NULL,
  health_factor        REAL,
  total_collateral_usd REAL,
  total_debt_usd       REAL,
  block_number         INTEGER,
  snapshot_json        TEXT,
  error                TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_pos_at ON snapshots (network, address, at);

-- Alert outbox + log. The primary key makes inserting the same alert twice impossible.
CREATE TABLE IF NOT EXISTS alerts (
  id              TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network         TEXT NOT NULL,
  address         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  severity        TEXT NOT NULL,
  level           INTEGER NOT NULL,
  health_factor   REAL,
  message         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  sent_at         INTEGER,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts (user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  user_id  INTEGER,
  network  TEXT,
  address  TEXT,
  event_id TEXT NOT NULL,
  kind     TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);

CREATE TABLE IF NOT EXISTS network_health (
  network     TEXT PRIMARY KEY,
  health_json TEXT NOT NULL
);
`;
