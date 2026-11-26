// SQLite implementation of Store, using Node's built-in `node:sqlite` (no native build step).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Address } from 'viem';
import type { AlertState } from '../alerts/engine.js';
import { DEFAULT_ALERT_SETTINGS, validateAlertSettings, type AlertSettings } from '../alerts/settings.js';
import type { NetworkKey } from '../chain/networks.js';
import type { NetworkHealth } from '../core/types.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import type {
  AlertRow,
  AuditRow,
  CommitEvaluationInput,
  SnapshotRow,
  Store,
  UserRow,
  WalletRow,
  WatchedWallet,
} from './Store.js';

type Row = Record<string, SQLInputValue>;

/** "file:./data/guardian.db" → "./data/guardian.db"; ":memory:" stays as is. */
export function sqlitePathFromUrl(url: string): string {
  if (url === ':memory:' || url === 'file::memory:') return ':memory:';
  return url.startsWith('file:') ? url.slice('file:'.length) : url;
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  async migrate(): Promise<void> {
    this.db.exec(SCHEMA_SQL);
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /** Runs fn inside one transaction: everything is saved, or nothing is. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------------------------------------------------------------- users

  async upsertUserByChat(chatId: string, defaults: AlertSettings, now: number): Promise<UserRow> {
    this.db
      .prepare('INSERT INTO users (chat_id, settings_json, active, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(chat_id) DO UPDATE SET active = 1')
      .run(chatId, JSON.stringify(defaults), now);
    return (await this.getUserByChat(chatId))!;
  }

  async getUserByChat(chatId: string): Promise<UserRow | null> {
    const r = this.db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId) as Row | undefined;
    return r ? toUser(r) : null;
  }

  async updateUserSettings(userId: number, settings: AlertSettings): Promise<void> {
    this.db.prepare('UPDATE users SET settings_json = ? WHERE id = ?').run(JSON.stringify(settings), userId);
  }

  async setUserActive(userId: number, active: boolean): Promise<void> {
    this.db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, userId);
  }

  // ---------------------------------------------------------------- wallets

  async addWallet(userId: number, network: NetworkKey, address: Address, label: string | null, now: number): Promise<boolean> {
    const r = this.db
      .prepare('INSERT INTO wallets (user_id, network, address, label, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .run(userId, network, address, label, now);
    return Number(r.changes) > 0;
  }

  async removeWallet(userId: number, network: NetworkKey, address: Address): Promise<boolean> {
    return this.tx(() => {
      const r = this.db.prepare('DELETE FROM wallets WHERE user_id = ? AND network = ? AND address = ?').run(userId, network, address);
      this.db.prepare('DELETE FROM alert_states WHERE user_id = ? AND network = ? AND address = ?').run(userId, network, address);
      return Number(r.changes) > 0;
    });
  }

  async listWallets(userId: number): Promise<WalletRow[]> {
    return (this.db.prepare('SELECT * FROM wallets WHERE user_id = ? ORDER BY id').all(userId) as Row[]).map(toWallet);
  }

  async listWatchedWallets(): Promise<WatchedWallet[]> {
    const rows = this.db
      .prepare('SELECT w.*, u.chat_id FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.active = 1 ORDER BY w.id')
      .all() as Row[];
    return rows.map((r) => ({ ...toWallet(r), chatId: String(r.chat_id) }));
  }

  // ---------------------------------------------------------------- snapshots

  async insertSnapshots(rows: SnapshotRow[]): Promise<void> {
    if (!rows.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO snapshots (network, address, at, status, health_factor, total_collateral_usd, total_debt_usd, block_number, snapshot_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.tx(() => {
      for (const s of rows) {
        stmt.run(s.network, s.address, s.at, s.status, s.healthFactor, s.totalCollateralUsd, s.totalDebtUsd, s.blockNumber,
          s.snapshot ? JSON.stringify(s.snapshot) : null, s.error);
      }
    });
  }

  async latestSnapshot(network: NetworkKey, address: Address): Promise<SnapshotRow | null> {
    const r = this.db
      .prepare('SELECT * FROM snapshots WHERE network = ? AND address = ? ORDER BY at DESC, id DESC LIMIT 1')
      .get(network, address) as Row | undefined;
    return r ? toSnapshot(r) : null;
  }

  async latestOkSnapshot(network: NetworkKey, address: Address): Promise<SnapshotRow | null> {
    const r = this.db
      .prepare("SELECT * FROM snapshots WHERE network = ? AND address = ? AND status = 'ok' ORDER BY at DESC, id DESC LIMIT 1")
      .get(network, address) as Row | undefined;
    return r ? toSnapshot(r) : null;
  }

  async snapshotHistory(network: NetworkKey, address: Address, sinceMs: number): Promise<SnapshotRow[]> {
    const rows = this.db
      .prepare('SELECT * FROM snapshots WHERE network = ? AND address = ? AND at >= ? ORDER BY at, id')
      .all(network, address, sinceMs) as Row[];
    return rows.map(toSnapshot);
  }

  async pruneSnapshots(olderThanMs: number): Promise<number> {
    return Number(this.db.prepare('DELETE FROM snapshots WHERE at < ?').run(olderThanMs).changes);
  }

  // ---------------------------------------------------------------- alert state + outbox

  async getAlertState(userId: number, network: NetworkKey, address: Address): Promise<AlertState | null> {
    const r = this.db
      .prepare('SELECT state_json FROM alert_states WHERE user_id = ? AND network = ? AND address = ?')
      .get(userId, network, address) as Row | undefined;
    return r ? (JSON.parse(String(r.state_json)) as AlertState) : null;
  }

  async commitEvaluation(input: CommitEvaluationInput): Promise<void> {
    const { userId, network, address } = input;
    this.tx(() => {
      const now = input.state.lastEvaluatedAt ?? Date.now();
      this.db
        .prepare(
          `INSERT INTO alert_states (user_id, network, address, state_json, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, network, address) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
        )
        .run(userId, network, address, JSON.stringify(input.state), now);
      const insertAlert = this.db.prepare(
        `INSERT INTO alerts (id, user_id, network, address, kind, severity, level, health_factor, message, created_at, status, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?) ON CONFLICT(id) DO NOTHING`,
      );
      for (const { event: e, message } of input.events) {
        insertAlert.run(`${userId}:${e.id}`, userId, network, address, e.kind, e.severity, e.level, e.healthFactor, message, e.at, e.at);
      }
      this.insertAudit(input.audit.map((a) => ({ ...a, eventId: `${userId}:${a.eventId}`, userId, network, address })));
    });
  }

  async claimDueAlerts(now: number, limit: number): Promise<AlertRow[]> {
    return this.tx(() => {
      const rows = this.db
        .prepare(
          `SELECT a.*, u.chat_id FROM alerts a JOIN users u ON u.id = a.user_id
           WHERE a.status = 'pending' AND a.next_attempt_at <= ? ORDER BY a.created_at, a.id LIMIT ?`,
        )
        .all(now, limit) as Row[];
      const mark = this.db.prepare(`UPDATE alerts SET status = 'sending', attempts = attempts + 1 WHERE id = ?`);
      for (const r of rows) mark.run(String(r.id));
      return rows.map((r) => ({ ...toAlert(r), status: 'sending' as const, attempts: Number(r.attempts) + 1 }));
    });
  }

  async markAlertSent(id: string, now: number): Promise<void> {
    this.db.prepare(`UPDATE alerts SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`).run(now, id);
  }

  async markAlertFailed(id: string, error: string, retryAt: number | null): Promise<void> {
    if (retryAt === null) {
      this.db.prepare(`UPDATE alerts SET status = 'failed', last_error = ? WHERE id = ?`).run(error, id);
    } else {
      this.db.prepare(`UPDATE alerts SET status = 'pending', last_error = ?, next_attempt_at = ? WHERE id = ?`).run(error, retryAt, id);
    }
  }

  async recoverInterruptedSends(now: number): Promise<number> {
    return this.tx(() => {
      const rows = this.db.prepare(`SELECT id, user_id, network, address, kind FROM alerts WHERE status = 'sending'`).all() as Row[];
      this.db.prepare(`UPDATE alerts SET status = 'uncertain', last_error = 'app stopped while sending; not resent to avoid a duplicate' WHERE status = 'sending'`).run();
      this.insertAudit(
        rows.map((r) => ({
          at: now,
          eventId: String(r.id),
          kind: String(r.kind) as AuditRow['kind'],
          decision: 'suppress',
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
    const where = opts.userId !== undefined ? 'WHERE a.user_id = ?' : '';
    const params: SQLInputValue[] = opts.userId !== undefined ? [opts.userId, opts.limit] : [opts.limit];
    const rows = this.db
      .prepare(`SELECT a.*, u.chat_id FROM alerts a JOIN users u ON u.id = a.user_id ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
      .all(...params) as Row[];
    return rows.map(toAlert);
  }

  // ---------------------------------------------------------------- audit

  async appendAudit(rows: AuditRow[]): Promise<void> {
    this.tx(() => this.insertAudit(rows));
  }

  private insertAudit(rows: AuditRow[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO audit_log (at, user_id, network, address, event_id, kind, decision, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const a of rows) stmt.run(a.at, a.userId, a.network, a.address, a.eventId, a.kind, a.decision, a.reason);
  }

  async listAudit(limit: number, opts: { userId?: number } = {}): Promise<AuditRow[]> {
    const rows = (
      opts.userId !== undefined
        ? this.db.prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(opts.userId, limit)
        : this.db.prepare('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?').all(limit)
    ) as Row[];
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
    const stmt = this.db.prepare(
      'INSERT INTO network_health (network, health_json) VALUES (?, ?) ON CONFLICT(network) DO UPDATE SET health_json = excluded.health_json',
    );
    this.tx(() => {
      for (const h of health) stmt.run(h.network, JSON.stringify(h));
    });
  }

  async loadNetworkHealth(): Promise<NetworkHealth[]> {
    const rows = this.db.prepare('SELECT health_json FROM network_health ORDER BY network').all() as Row[];
    return rows.map((r) => JSON.parse(String(r.health_json)) as NetworkHealth);
  }
}

// ------------------------------------------------------------------ row mappers

function toUser(r: Row): UserRow {
  // Re-validate stored settings; fall back to defaults if the stored JSON is ever invalid.
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

const numOrNull = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : Number(v));

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
