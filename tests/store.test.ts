import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluate, initialAlertState } from '../src/alerts/engine.js';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/settings.js';
import { SqliteStore, sqlitePathFromUrl } from '../src/db/SqliteStore.js';
import { DEMO_SCENARIOS, simulatePosition } from '../src/datasources/simulated.js';

const T = 1_800_000_000_000;
const sc = DEMO_SCENARIOS.find((s) => s.id === 'steady')!;
let store: SqliteStore;

beforeEach(async () => {
  store = new SqliteStore(':memory:');
  await store.migrate();
});
afterEach(async () => {
  await store.close();
});

async function userWithAlert() {
  const user = await store.upsertUserByChat('111', DEFAULT_ALERT_SETTINGS, T);
  const snapshot = { ...simulatePosition(sc, T), healthFactor: 1.2 };
  const out = evaluate(initialAlertState(), { network: sc.network, wallet: sc.wallet, status: 'ok', snapshot, fetchedAt: T }, DEFAULT_ALERT_SETTINGS, T);
  const input = {
    userId: user.id, network: sc.network, address: sc.wallet, state: out.state, audit: out.audit,
    events: out.events.map((event) => ({ event, message: `msg ${event.kind}` })),
  };
  await store.commitEvaluation(input);
  return { user, input };
}

describe('SqliteStore', () => {
  it('parses DATABASE_URL', () => {
    expect(sqlitePathFromUrl('file:./data/guardian.db')).toBe('./data/guardian.db');
    expect(sqlitePathFromUrl(':memory:')).toBe(':memory:');
  });

  it('upserts users by chat id and stores settings', async () => {
    const a = await store.upsertUserByChat('42', DEFAULT_ALERT_SETTINGS, T);
    const b = await store.upsertUserByChat('42', DEFAULT_ALERT_SETTINGS, T + 1);
    expect(a.id).toBe(b.id);
    await store.updateUserSettings(a.id, { ...DEFAULT_ALERT_SETTINGS, thresholds: [2, 1.3] });
    expect((await store.getUserByChat('42'))!.settings.thresholds).toEqual([2, 1.3]);
  });

  it('adds wallets once, lists them, and removing a wallet also clears its alert state', async () => {
    const { user } = await userWithAlert();
    expect(await store.addWallet(user.id, sc.network, sc.wallet, 'main', T)).toBe(true);
    expect(await store.addWallet(user.id, sc.network, sc.wallet, 'again', T)).toBe(false);
    expect(await store.listWallets(user.id)).toHaveLength(1);
    expect(await store.getAlertState(user.id, sc.network, sc.wallet)).not.toBeNull();
    expect(await store.removeWallet(user.id, sc.network, sc.wallet)).toBe(true);
    expect(await store.getAlertState(user.id, sc.network, sc.wallet)).toBeNull();
  });

  it('only lists wallets of active users for monitoring', async () => {
    const u = await store.upsertUserByChat('7', DEFAULT_ALERT_SETTINGS, T);
    await store.addWallet(u.id, sc.network, sc.wallet, null, T);
    expect(await store.listWatchedWallets()).toHaveLength(1);
    await store.setUserActive(u.id, false);
    expect(await store.listWatchedWallets()).toHaveLength(0);
  });

  it('stores snapshots, returns latest and history, and prunes old ones', async () => {
    const snap = simulatePosition(sc, T);
    const row = (at: number, hf: number | null) => ({
      network: sc.network, address: sc.wallet, at, status: 'ok' as const, healthFactor: hf,
      totalCollateralUsd: 1, totalDebtUsd: 1, blockNumber: 1, snapshot: snap, error: null,
    });
    await store.insertSnapshots([row(T, 2), row(T + 60_000, 1.9), row(T + 120_000, null)]);
    expect((await store.latestSnapshot(sc.network, sc.wallet))!.healthFactor).toBeNull();
    expect((await store.snapshotHistory(sc.network, sc.wallet, T + 60_000)).map((r) => r.healthFactor)).toEqual([1.9, null]);
    expect(await store.pruneSnapshots(T + 1)).toBe(1);
    expect(await store.snapshotHistory(sc.network, sc.wallet, 0)).toHaveLength(2);
  });

  it('commitEvaluation is idempotent: the same event saved twice is stored once', async () => {
    const { input } = await userWithAlert();
    await store.commitEvaluation(input);
    expect(await store.listAlerts({ limit: 10 })).toHaveLength(1);
  });

  it('outbox: claim → sending; a second claim returns nothing', async () => {
    await userWithAlert();
    const claimed = await store.claimDueAlerts(T, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ status: 'sending', attempts: 1, chatId: '111' });
    expect(await store.claimDueAlerts(T, 10)).toHaveLength(0);
  });

  it('outbox: interrupted sends become "uncertain", are audited, and are never claimed again', async () => {
    await userWithAlert();
    await store.claimDueAlerts(T, 10); // app "dies" here, before markAlertSent
    expect(await store.recoverInterruptedSends(T + 1)).toBe(1);
    expect((await store.listAlerts({ limit: 1 }))[0]!.status).toBe('uncertain');
    expect(await store.claimDueAlerts(T + 999_999, 10)).toHaveLength(0);
    expect((await store.listAudit(5))[0]!.reason).toMatch(/not resent/);
  });

  it('outbox: a failed send with retry goes back to pending at the retry time', async () => {
    await userWithAlert();
    const [a] = await store.claimDueAlerts(T, 10);
    await store.markAlertFailed(a!.id, 'timeout', T + 5_000);
    expect(await store.claimDueAlerts(T + 4_999, 10)).toHaveLength(0);
    expect(await store.claimDueAlerts(T + 5_000, 10)).toHaveLength(1);
  });

  it('persists network health', async () => {
    const h = { network: 'base' as const, lastSuccessAt: T, lastErrorAt: null, lastError: null, consecutiveFailures: 0, lastBlockNumber: 5 };
    await store.saveNetworkHealth([h]);
    expect(await store.loadNetworkHealth()).toEqual([h]);
  });

  it('survives a restart: data in a file database is still there after reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apg-'));
    try {
      const file = join(dir, 'g.db');
      const s1 = new SqliteStore(file);
      await s1.migrate();
      const u = await s1.upsertUserByChat('9', DEFAULT_ALERT_SETTINGS, T);
      await s1.addWallet(u.id, sc.network, sc.wallet, null, T);
      await s1.close();
      const s2 = new SqliteStore(file);
      await s2.migrate();
      expect(await s2.listWatchedWallets()).toHaveLength(1);
      await s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
