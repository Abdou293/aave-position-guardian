// PostgreSQL implementation of Store (for hosting, where the local disk is not persistent).
// Same behaviour as SqliteStore; the shared contract tests run against both.
//
// It talks to the database through a tiny driver interface, so tests can use PGlite (real
// Postgres compiled to WebAssembly, in-process) and production uses the `pg` connection pool.
import type { Address } from 'viem';
import type { AlertState } from '../alerts/engine.js';
import { DEFAULT_ALERT_SETTINGS, validateAlertSettings, type AlertSettings } from '../alerts/settings.js';
import type { NetworkKey } from '../chain/networks.js';
import type { NetworkHealth } from '../core/types.js';
import { SCHEMA_VERSION } from './schema.js';
import type { AlertRow, AuditRow, CommitEvaluationInput, SnapshotRow, Store, UserRow, WalletRow, WatchedWallet } from './Store.js';

type Row = Record<string, unknown>;

export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; affectedRows?: number }>;
}

export interface PgDriver extends PgQueryable {
  /** Runs fn in ONE transaction (all or nothing). */
  transaction<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export const PG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  chat_id       TEXT NOT NULL UNIQUE,
  settings_json TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network    TEXT NOT NULL,
  address    TEXT NOT NULL,
  label      TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, network, address)
);

CREATE TABLE IF NOT EXISTS alert_states (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network    TEXT NOT NULL,
  address    TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, network, address)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id                   BIGSERIAL PRIMARY KEY,
  network              TEXT NOT NULL,
  address              TEXT NOT NULL,
  at                   BIGINT NOT NULL,
  status               TEXT NOT NULL,
  health_factor        DOUBLE PRECISION,
  total_collateral_usd DOUBLE PRECISION,
  total_debt_usd       DOUBLE PRECISION,
  block_number         BIGINT,
  snapshot_json        TEXT,
  error                TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_pos_at ON snapshots (network, address, at);

CREATE TABLE IF NOT EXISTS alerts (
  id              TEXT PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network         TEXT NOT NULL,
  address         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  severity        TEXT NOT NULL,
  level           INTEGER NOT NULL,
  health_factor   DOUBLE PRECISION,
  message         TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL,
  sent_at         BIGINT,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts (user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id       BIGSERIAL PRIMARY KEY,
  at       BIGINT NOT NULL,
  user_id  BIGINT,
  network  TEXT,
  address  TEXT,
  event_id TEXT NOT NULL,
  kind     TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);

CREATE TABLE IF NOT EXISTS network_health (network TEXT PRIMARY KEY, health_json TEXT NOT NULL);
`;

const ALERT_COLUMNS = `a.id, a.user_id, a.network, a.address, a.kind, a.severity, a.level, a.health_factor, a.message,
  a.created_at, a.status, a.attempts, a.next_attempt_at, a.sent_at, a.last_error`;

export class PostgresStore implements Store {
  constructor(private readonly db: PgDriver) {}

  async migrate(): Promise<void> {
    await this.db.exec(PG_SCHEMA_SQL);
    await this.db.query(
      'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      ['schema_version', String(SCHEMA_VERSION)],
    );
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // ---------------------------------------------------------------- users

  async upsertUserByChat(chatId: string, defaults: AlertSettings, now: number): Promise<UserRow> {
    const { rows } = await this.db.query(
      `INSERT INTO users (chat_id, settings_json, active, created_at) VALUES ($1, $2, 1, $3)
       ON CONFLICT (chat_id) DO UPDATE SET active = 1 RETURNING *`,
      [chatId, JSON.stringify(defaults), now],
    );
    return toUser(rows[0]!);
  }

  async getUserByChat(chatId: string): Promise<UserRow | null> {
    const { rows } = await this.db.query('SELECT * FROM users WHERE chat_id = $1', [chatId]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async updateUserSettings(userId: number, settings: AlertSettings): Promise<void> {
    await this.db.query('UPDATE users SET settings_json = $1 WHERE id = $2', [JSON.stringify(settings), userId]);
  }

  async setUserActive(userId: number, active: boolean): Promise<void> {
    await this.db.query('UPDATE users SET active = $1 WHERE id = $2', [active ? 1 : 0, userId]);
  }

  // ---------------------------------------------------------------- wallets

  async addWallet(userId: number, network: NetworkKey, address: Address, label: string | null, now: number): Promise<boolean> {
    const { rows } = await this.db.query(
      `INSERT INTO wallets (user_id, network, address, label, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING RETURNING id`,
      [userId, network, address, label, now],
    );
    return rows.length > 0;
  }

  async removeWallet(userId: number, network: NetworkKey, address: Address): Promise<boolean> {
    return this.db.transaction(async (q) => {
      const { rows } = await q.query('DELETE FROM wallets WHERE user_id = $1 AND network = $2 AND address = $3 RETURNING id', [userId, network, address]);
      await q.query('DELETE FROM alert_states WHERE user_id = $1 AND network = $2 AND address = $3', [userId, network, address]);
      return rows.length > 0;
    });
  }

  async listWallets(userId: number): Promise<WalletRow[]> {
    const { rows } = await this.db.query('SELECT * FROM wallets WHERE user_id = $1 ORDER BY id', [userId]);
    return rows.map(toWallet);
  }

  async listWatchedWallets(): Promise<WatchedWallet[]> {
    const { rows } = await this.db.query(
      'SELECT w.*, u.chat_id FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.active = 1 ORDER BY w.id',
    );
    return rows.map((r) => ({ ...toWallet(r), chatId: String(r.chat_id) }));
  }

  // ---------------------------------------------------------------- snapshots

  async insertSnapshots(rows: SnapshotRow[]): Promise<void> {
    if (!rows.length) return;
    await this.db.transaction(async (q) => {
      for (const s of rows) {
        await q.query(
          `INSERT INTO snapshots (network, address, at, status, health_factor, total_collateral_usd, total_debt_usd, block_number, snapshot_json, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [s.network, s.address, s.at, s.status, s.healthFactor, s.totalCollateralUsd, s.totalDebtUsd, s.blockNumber,
            s.snapshot ? JSON.stringify(s.snapshot) : null, s.error],
        );
      }
    });
  }

  async latestSnapshot(network: NetworkKey, address: Address): Promise<SnapshotRow | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM snapshots WHERE network = $1 AND address = $2 ORDER BY at DESC, id DESC LIMIT 1', [network, address]);
    return rows[0] ? toSnapshot(rows[0]) : null;
  }

  async latestOkSnapshot(network: NetworkKey, address: Address): Promise<SnapshotRow | null> {
    const { rows } = await this.db.query(
      "SELECT * FROM snapshots WHERE network = $1 AND address = $2 AND status = 'ok' ORDER BY at DESC, id DESC LIMIT 1", [network, address]);
    return rows[0] ? toSnapshot(rows[0]) : null;
  }

  async snapshotHistory(network: NetworkKey, address: Address, sinceMs: number): Promise<SnapshotRow[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM snapshots WHERE network = $1 AND address = $2 AND at >= $3 ORDER BY at, id', [network, address, sinceMs]);
    return rows.map(toSnapshot);
  }

  async pruneSnapshots(olderThanMs: number): Promise<number> {
    const { rows } = await this.db.query('DELETE FROM snapshots WHERE at < $1 RETURNING id', [olderThanMs]);
    return rows.length;
  }

  // ---------------------------------------------------------------- alert state + outbox

  async getAlertState(userId: number, network: NetworkKey, address: Address): Promise<AlertState | null> {
    const { rows } = await this.db.query(
      'SELECT state_json FROM alert_states WHERE user_id = $1 AND network = $2 AND address = $3', [userId, network, address]);
    return rows[0] ? (JSON.parse(String(rows[0].state_json)) as AlertState) : null;
  }

  async commitEvaluation(input: CommitEvaluationInput): Promise<void> {
    const { userId, network, address } = input;
    await this.db.transaction(async (q) => {
      const now = input.state.lastEvaluatedAt ?? Date.now();
      await q.query(
        `INSERT INTO alert_states (user_id, network, address, state_json, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, network, address) DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = EXCLUDED.updated_at`,
        [userId, network, address, JSON.stringify(input.state), now],
      );
      for (const { event: e, message } of input.events) {
        await q.query(
          `INSERT INTO alerts (id, user_id, network, address, kind, severity, level, health_factor, message, created_at, status, attempts, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 0, $11) ON CONFLICT (id) DO NOTHING`,
          [`${userId}:${e.id}`, userId, network, address, e.kind, e.severity, e.level, e.healthFactor, message, e.at, e.at],
        );
      }
      await insertAudit(q, input.audit.map((a) => ({ ...a, eventId: `${userId}:${a.eventId}`, userId, network, address })));
    });
  }

  async claimDueAlerts(now: number, limit: number): Promise<AlertRow[]> {
    return this.db.transaction(async (q) => {
      // SKIP LOCKED: two app instances can never claim the same alert.
      const { rows } = await q.query(
        `UPDATE alerts SET status = 'sending', attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM alerts WHERE status = 'pending' AND next_attempt_at <= $1
           ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
         ) RETURNING id`,
        [now, limit],
      );
      if (!rows.length) return [];
      const ids = rows.map((r) => String(r.id));
      const full = await q.query(
        `SELECT ${ALERT_COLUMNS}, u.chat_id FROM alerts a JOIN users u ON u.id = a.user_id
         WHERE a.id = ANY($1::text[]) ORDER BY a.created_at, a.id`,
        [ids],
      );
      return full.rows.map(toAlert);
    });
  }

  async markAlertSent(id: string, now: number): Promise<void> {
    await this.db.query(`UPDATE alerts SET status = 'sent', sent_at = $1, last_error = NULL WHERE id = $2`, [now, id]);
  }

  async markAlertFailed(id: string, error: string, retryAt: number | null): Promise<void> {
    if (retryAt === null) {
      await this.db.query(`UPDATE alerts SET status = 'failed', last_error = $1 WHERE id = $2`, [error, id]);
    } else {
      await this.db.query(`UPDATE alerts SET status = 'pending', last_error = $1, next_attempt_at = $2 WHERE id = $3`, [error, retryAt, id]);
    }
  }

  async recoverInterruptedSends(now: number): Promise<number> {
    return this.db.transaction(async (q) => {
      const { rows } = await q.query(
        `UPDATE alerts SET status = 'uncertain', last_error = 'app stopped while sending; not resent to avoid a duplicate'
         WHERE status = 'sending' RETURNING id, user_id, network, address, kind`,
      );
      await insertAudit(
        q,
        rows.map((r) => ({
          at: now,
          eventId: String(r.id),
          kind: String(r.kind) as AuditRow['kind'],
          decision: 'suppress' as const,
          reason: 'restart: delivery uncertain, not resent (avoids duplicate alerts)',
          userId: Number(r.user_id),
          network: String(r.network) as NetworkKey,
          address: String(r.address) as Address,
        })),
      );
      return rows.length;
    });
  }

  async listAlerts(opts: { userId?: number; limit: number }): Promise<AlertRow[]> {
    const { rows } =
      opts.userId !== undefined
        ? await this.db.query(
            `SELECT ${ALERT_COLUMNS}, u.chat_id FROM alerts a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1
             ORDER BY a.created_at DESC, a.id DESC LIMIT $2`,
            [opts.userId, opts.limit],
          )
        : await this.db.query(
            `SELECT ${ALERT_COLUMNS}, u.chat_id FROM alerts a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC, a.id DESC LIMIT $1`,
            [opts.limit],
          );
    return rows.map(toAlert);
  }

  // ---------------------------------------------------------------- audit

  async appendAudit(rows: AuditRow[]): Promise<void> {
    await this.db.transaction((q) => insertAudit(q, rows));
  }

  async listAudit(limit: number, opts: { userId?: number } = {}): Promise<AuditRow[]> {
    const { rows } =
      opts.userId !== undefined
        ? await this.db.query('SELECT * FROM audit_log WHERE user_id = $1 ORDER BY at DESC, id DESC LIMIT $2', [opts.userId, limit])
        : await this.db.query('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT $1', [limit]);
    return rows.map((r) => ({
      at: Number(r.at),
      userId: r.user_id === null ? null : Number(r.user_id),
      network: (r.network as NetworkKey | null) ?? null,
      address: (r.address as Address | null) ?? null,
      eventId: String(r.event_id),
      kind: String(r.kind) as AuditRow['kind'],
      decision: String(r.decision) as AuditRow['decision'],
      reason: String(r.reason),
    }));
  }

  // ---------------------------------------------------------------- network health

  async saveNetworkHealth(health: NetworkHealth[]): Promise<void> {
    await this.db.transaction(async (q) => {
      for (const h of health) {
        await q.query(
          'INSERT INTO network_health (network, health_json) VALUES ($1, $2) ON CONFLICT (network) DO UPDATE SET health_json = EXCLUDED.health_json',
          [h.network, JSON.stringify(h)],
        );
      }
    });
  }

  async loadNetworkHealth(): Promise<NetworkHealth[]> {
    const { rows } = await this.db.query('SELECT health_json FROM network_health ORDER BY network');
    return rows.map((r) => JSON.parse(String(r.health_json)) as NetworkHealth);
  }
}

async function insertAudit(q: PgQueryable, rows: AuditRow[]): Promise<void> {
  for (const a of rows) {
    await q.query(
      'INSERT INTO audit_log (at, user_id, network, address, event_id, kind, decision, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [a.at, a.userId, a.network, a.address, a.eventId, a.kind, a.decision, a.reason],
    );
  }
}

// ------------------------------------------------------------------ row mappers (BIGINT may arrive as string)

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toUser(r: Row): UserRow {
  const parsed = validateAlertSettings(JSON.parse(String(r.settings_json)) as Partial<AlertSettings>);
  return {
    id: Number(r.id),
    chatId: String(r.chat_id),
    settings: parsed.ok ? parsed.settings : { ...DEFAULT_ALERT_SETTINGS },
    active: Number(r.active) === 1,
    createdAt: Number(r.created_at),
  };
}

function toWallet(r: Row): WalletRow {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    network: String(r.network) as NetworkKey,
    address: String(r.address) as Address,
    label: r.label === null ? null : String(r.label),
    createdAt: Number(r.created_at),
  };
}

function toSnapshot(r: Row): SnapshotRow {
  return {
    network: String(r.network) as NetworkKey,
    address: String(r.address) as Address,
    at: Number(r.at),
    status: String(r.status) as SnapshotRow['status'],
    healthFactor: numOrNull(r.health_factor),
    totalCollateralUsd: numOrNull(r.total_collateral_usd),
    totalDebtUsd: numOrNull(r.total_debt_usd),
    blockNumber: numOrNull(r.block_number),
    snapshot: r.snapshot_json ? JSON.parse(String(r.snapshot_json)) : null,
    error: r.error === null ? null : String(r.error),
  };
}

function toAlert(r: Row): AlertRow {
  return {
    id: String(r.id),
    userId: Number(r.user_id),
    chatId: String(r.chat_id),
    network: String(r.network) as NetworkKey,
    address: String(r.address) as Address,
    kind: String(r.kind) as AlertRow['kind'],
    severity: String(r.severity) as AlertRow['severity'],
    level: Number(r.level),
    healthFactor: numOrNull(r.health_factor),
    message: String(r.message),
    createdAt: Number(r.created_at),
    status: String(r.status) as AlertRow['status'],
    attempts: Number(r.attempts),
    nextAttemptAt: Number(r.next_attempt_at),
    sentAt: numOrNull(r.sent_at),
    lastError: r.last_error === null ? null : String(r.last_error),
  };
}
