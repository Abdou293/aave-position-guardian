// DATA-ACCESS LAYER: the only way the app talks to the database.
// SqliteStore implements it for development. A PostgresStore can implement the same interface
// for hosting, without changing the monitor, bot or API code. All methods are async for that reason.
import type { Address } from 'viem';
import type { AlertEvent, AlertSeverity, AlertKind, AlertState, AuditEntry } from '../alerts/engine.js';
import type { AlertSettings } from '../alerts/settings.js';
import type { NetworkKey } from '../chain/networks.js';
import type { NetworkHealth, PositionSnapshot, ReadStatus } from '../core/types.js';

export interface UserRow {
  id: number;
  /** Telegram chat id (string: it can exceed JS safe integers in theory). */
  chatId: string;
  settings: AlertSettings;
  active: boolean;
  createdAt: number;
}

export interface WalletRow {
  id: number;
  userId: number;
  network: NetworkKey;
  address: Address;
  label: string | null;
  createdAt: number;
}

export interface WatchedWallet extends WalletRow {
  chatId: string;
}

export interface SnapshotRow {
  network: NetworkKey;
  address: Address;
  at: number;
  status: ReadStatus;
  healthFactor: number | null;
  totalCollateralUsd: number | null;
  totalDebtUsd: number | null;
  blockNumber: number | null;
  snapshot: PositionSnapshot | null;
  error: string | null;
}

/**
 * Outbox status of an alert:
 *  pending   = saved, waiting to be sent
 *  sending   = claimed by the sender
 *  sent      = delivered to Telegram
 *  failed    = gave up (permanent error or too many attempts)
 *  uncertain = the app stopped DURING sending; we do NOT resend (avoids duplicates), see audit log
 */
export type AlertStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain';

export interface AlertRow {
  id: string;
  userId: number;
  chatId: string;
  network: NetworkKey;
  address: Address;
  kind: AlertKind;
  severity: AlertSeverity;
  level: number;
  healthFactor: number | null;
  message: string;
  createdAt: number;
  status: AlertStatus;
  attempts: number;
  nextAttemptAt: number;
  sentAt: number | null;
  lastError: string | null;
}

export interface AuditRow extends AuditEntry {
  userId: number | null;
  network: NetworkKey | null;
  address: Address | null;
}

export interface CommitEvaluationInput {
  userId: number;
  network: NetworkKey;
  address: Address;
  state: AlertState;
  events: Array<{ event: AlertEvent; message: string }>;
  audit: AuditEntry[];
}

export interface Store {
  migrate(): Promise<void>;
  close(): Promise<void>;

  // Users
  upsertUserByChat(chatId: string, defaults: AlertSettings, now: number): Promise<UserRow>;
  getUserByChat(chatId: string): Promise<UserRow | null>;
  updateUserSettings(userId: number, settings: AlertSettings): Promise<void>;
  setUserActive(userId: number, active: boolean): Promise<void>;

  // Wallets
  addWallet(userId: number, network: NetworkKey, address: Address, label: string | null, now: number): Promise<boolean>;
  removeWallet(userId: number, network: NetworkKey, address: Address): Promise<boolean>;
  listWallets(userId: number): Promise<WalletRow[]>;
  /** All wallets of active users (what the monitor must read). */
  listWatchedWallets(): Promise<WatchedWallet[]>;

  // Snapshots (health-factor history)
  insertSnapshots(rows: SnapshotRow[]): Promise<void>;
  latestSnapshot(network: NetworkKey, address: Address): Promise<SnapshotRow | null>;
  /** Latest FRESH (status ok) snapshot, used to show the last known values when reads fail. */
  latestOkSnapshot(network: NetworkKey, address: Address): Promise<SnapshotRow | null>;
  snapshotHistory(network: NetworkKey, address: Address, sinceMs: number): Promise<SnapshotRow[]>;
  pruneSnapshots(olderThanMs: number): Promise<number>;

  // Alert engine state + alert outbox (written together, atomically)
  getAlertState(userId: number, network: NetworkKey, address: Address): Promise<AlertState | null>;
  commitEvaluation(input: CommitEvaluationInput): Promise<void>;
  /** Atomically moves due `pending` alerts to `sending` and returns them. */
  claimDueAlerts(now: number, limit: number): Promise<AlertRow[]>;
  markAlertSent(id: string, now: number): Promise<void>;
  /** retryAt = null means give up (status `failed`), otherwise back to `pending` at that time. */
  markAlertFailed(id: string, error: string, retryAt: number | null): Promise<void>;
  /** On startup: alerts stuck in `sending` become `uncertain` and are NOT resent. */
  recoverInterruptedSends(now: number): Promise<number>;
  listAlerts(opts: { userId?: number; limit: number }): Promise<AlertRow[]>;

  // Audit log
  appendAudit(rows: AuditRow[]): Promise<void>;
  listAudit(limit: number, opts?: { userId?: number }): Promise<AuditRow[]>;

  // Network health (persisted so the dashboard survives restarts)
  saveNetworkHealth(health: NetworkHealth[]): Promise<void>;
  loadNetworkHealth(): Promise<NetworkHealth[]>;
}
