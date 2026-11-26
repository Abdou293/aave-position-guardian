// MONITOR: one cycle = read every watched position once, store a snapshot, run the alert engine
// for every user who watches it, and save state + alerts together (atomically).
import type { Address } from 'viem';
import { evaluate, initialAlertState } from '../alerts/engine.js';
import { formatAlert } from '../alerts/format.js';
import type { NetworkKey } from '../chain/networks.js';
import type { PositionDataSource, PositionReadResult, WatchTarget } from '../core/types.js';
import type { SnapshotRow, Store, UserRow } from '../db/Store.js';

export interface MonitorOptions {
  store: Store;
  source: PositionDataSource;
  now?: () => number;
  /** Snapshots older than this are deleted (keeps the free database small). */
  snapshotRetentionMs?: number;
  /** How often old snapshots are pruned. */
  pruneEveryMs?: number;
}

export interface CycleReport {
  skipped: boolean;
  positions: number;
  ok: number;
  stale: number;
  error: number;
  alertsQueued: number;
  durationMs: number;
}

export class Monitor {
  private running = false;
  private lastPruneAt = 0;
  private readonly now: () => number;

  constructor(private readonly opts: MonitorOptions) {
    this.now = opts.now ?? Date.now;
  }

  async runCycle(): Promise<CycleReport> {
    const empty = { positions: 0, ok: 0, stale: 0, error: 0, alertsQueued: 0, durationMs: 0 };
    if (this.running) return { skipped: true, ...empty }; // never overlap two cycles
    this.running = true;
    const started = this.now();
    try {
      const { store, source } = this.opts;
      const watched = await store.listWatchedWallets();
      if (!watched.length) return { skipped: false, ...empty };

      // Read each distinct position ONCE, even if several users watch it.
      const key = (n: NetworkKey, a: Address) => `${n}:${a}`;
      const targets = new Map<string, WatchTarget>();
      for (const w of watched) targets.set(key(w.network, w.address), { network: w.network, wallet: w.address });
      const results = await source.getPositions([...targets.values()]);
      const byKey = new Map<string, PositionReadResult>(results.map((r) => [key(r.network, r.wallet), r]));
      const now = this.now();

      await store.insertSnapshots(results.map((r) => toSnapshotRow(r, now)));

      // Evaluate alerts per user (each user has their own thresholds and state).
      const users = new Map<string, UserRow | null>();
      let alertsQueued = 0;
      for (const w of watched) {
        const reading = byKey.get(key(w.network, w.address));
        if (!reading) continue;
        if (!users.has(w.chatId)) users.set(w.chatId, await store.getUserByChat(w.chatId));
        const user = users.get(w.chatId);
        if (!user) continue;
        const previous = (await store.getAlertState(user.id, w.network, w.address)) ?? initialAlertState();
        const out = evaluate(previous, reading, user.settings, now);
        await store.commitEvaluation({
          userId: user.id,
          network: w.network,
          address: w.address,
          state: out.state,
          events: out.events.map((event) => ({ event, message: formatAlert(event) })),
          audit: out.audit,
        });
        alertsQueued += out.events.length;
      }

      await store.saveNetworkHealth(source.getNetworkHealth());
      await this.maybePrune(now);

      return {
        skipped: false,
        positions: results.length,
        ok: results.filter((r) => r.status === 'ok').length,
        stale: results.filter((r) => r.status === 'stale').length,
        error: results.filter((r) => r.status === 'error').length,
        alertsQueued,
        durationMs: this.now() - started,
      };
    } finally {
      this.running = false;
    }
  }

  private async maybePrune(now: number) {
    const every = this.opts.pruneEveryMs ?? 60 * 60_000;
    if (now - this.lastPruneAt < every) return;
    this.lastPruneAt = now;
    await this.opts.store.pruneSnapshots(now - (this.opts.snapshotRetentionMs ?? 14 * 24 * 60 * 60_000));
  }
}

function toSnapshotRow(r: PositionReadResult, at: number): SnapshotRow {
  // Only FRESH readings carry numbers; stale/error rows record that the read failed.
  const s = r.status === 'ok' ? r.snapshot : null;
  return {
    network: r.network,
    address: r.wallet,
    at,
    status: r.status,
    healthFactor: s?.healthFactor ?? null,
    totalCollateralUsd: s?.totalCollateralUsd ?? null,
    totalDebtUsd: s?.totalDebtUsd ?? null,
    blockNumber: s?.blockNumber ?? null,
    snapshot: s,
    error: r.error ?? null,
  };
}
