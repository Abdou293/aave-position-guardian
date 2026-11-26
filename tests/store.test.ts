// Store CONTRACT tests: the same behaviour is required from SQLite (development) and
// PostgreSQL (hosting). Postgres runs in-process through PGlite (real Postgres in WebAssembly).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluate, initialAlertState } from '../src/alerts/engine.js';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/settings.js';
import { DEMO_SCENARIOS, DRILL_CYCLE_MS, SimulatedDataSource, simulatePosition } from '../src/datasources/simulated.js';
import { PostgresStore } from '../src/db/PostgresStore.js';
import { isPostgresUrl } from '../src/db/pgDriver.js';
import { SqliteStore, sqlitePathFromUrl } from '../src/db/SqliteStore.js';
import type { Store } from '../src/db/Store.js';
import { AlertDispatcher, type AlertSender } from '../src/monitor/dispatcher.js';
import { Monitor } from '../src/monitor/monitor.js';
import { createPgliteDriver } from './fixtures/pgliteDriver.js';

const T = 1_800_000_000_000;
const sc = DEMO_SCENARIOS.find((s) => s.id === 'steady')!;

/** Each factory opens a store at `path` (a temp dir), or in memory when path is undefined. */
const FACTORIES: Array<[string, (path?: string) => Store]> = [
  ['SQLite', (path) => new SqliteStore(path ? join(path, 'db.sqlite') : ':memory:')],
  ['PostgreSQL (PGlite)', (path) => new PostgresStore(createPgliteDriver(path ? join(path, 'pg') : undefined))],
];

it('parses DATABASE_URL', () => {
  expect(sqlitePathFromUrl('file:./data/guardian.db')).toBe('./data/guardian.db');
  expect(sqlitePathFromUrl(':memory:')).toBe(':memory:');
  expect(isPostgresUrl('postgresql://u@host/db?sslmode=require')).toBe(true);
  expect(isPostgresUrl('postgres://u@host/db')).toBe(true);
  expect(isPostgresUrl('file:./data/guardian.db')).toBe(false);
});

describe.each(FACTORIES)('Store contract: %s', (_name, open) => {
  let store: Store;

  beforeEach(async () => {
    store = open();
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

  it('migrate is idempotent', async () => {
    await store.migrate();
    expect(await store.listWatchedWallets()).toEqual([]);
  });

  it('upserts users by chat id and stores settings', async () => {
    const a = await store.upsertUserByChat('42', DEFAULT_ALERT_SETTINGS, T);
    const b = await store.upsertUserByChat('42', DEFAULT_ALERT_SETTINGS, T + 1);
    expect(a.id).toBe(b.id);
    expect(typeof a.id).toBe('number');
    await store.updateUserSettings(a.id, { ...DEFAULT_ALERT_SETTINGS, thresholds: [2, 1.3] });
    expect((await store.getUserByChat('42'))!.settings.thresholds).toEqual([2, 1.3]);
    expect(await store.getUserByChat('nope')).toBeNull();
  });

  it('adds wallets once, lists them, and removing a wallet also clears its alert state', async () => {
    const { user } = await userWithAlert();
    expect(await store.addWallet(user.id, sc.network, sc.wallet, 'main', T)).toBe(true);
    expect(await store.addWallet(user.id, sc.network, sc.wallet, 'again', T)).toBe(false);
    expect(await store.listWallets(user.id)).toMatchObject([{ userId: user.id, network: sc.network, address: sc.wallet, label: 'main', createdAt: T }]);
    expect(await store.getAlertState(user.id, sc.network, sc.wallet)).not.toBeNull();
    expect(await store.removeWallet(user.id, sc.network, sc.wallet)).toBe(true);
    expect(await store.removeWallet(user.id, sc.network, sc.wallet)).toBe(false);
    expect(await store.getAlertState(user.id, sc.network, sc.wallet)).toBeNull();
  });

  it('only lists wallets of active users for monitoring', async () => {
    const u = await store.upsertUserByChat('7', DEFAULT_ALERT_SETTINGS, T);
    await store.addWallet(u.id, sc.network, sc.wallet, null, T);
    expect(await store.listWatchedWallets()).toMatchObject([{ chatId: '7', label: null }]);
    await store.setUserActive(u.id, false);
    expect(await store.listWatchedWallets()).toHaveLength(0);
    await store.upsertUserByChat('7', DEFAULT_ALERT_SETTINGS, T); // /start again reactivates
    expect(await store.listWatchedWallets()).toHaveLength(1);
  });

  it('stores snapshots, returns latest / latest ok / history, and prunes old ones', async () => {
    const snap = simulatePosition(sc, T);
    const row = (at: number, hf: number | null, status: 'ok' | 'error' = 'ok') => ({
      network: sc.network, address: sc.wallet, at, status, healthFactor: hf,
      totalCollateralUsd: 1.5, totalDebtUsd: 1, blockNumber: 123, snapshot: status === 'ok' ? snap : null, error: status === 'ok' ? null : 'rpc down',
    });
    await store.insertSnapshots([row(T, 2), row(T + 60_000, 1.9), row(T + 120_000, null, 'error')]);
    expect(await store.latestSnapshot(sc.network, sc.wallet)).toMatchObject({ status: 'error', healthFactor: null, error: 'rpc down' });
    expect(await store.latestOkSnapshot(sc.network, sc.wallet)).toMatchObject({ at: T + 60_000, healthFactor: 1.9, totalCollateralUsd: 1.5, blockNumber: 123 });
    expect((await store.latestOkSnapshot(sc.network, sc.wallet))!.snapshot).toEqual(snap);
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
    expect(claimed[0]).toMatchObject({ status: 'sending', attempts: 1, chatId: '111', healthFactor: 1.2 });
    expect(await store.claimDueAlerts(T, 10)).toHaveLength(0);
  });

  it('outbox: sent alerts record the time', async () => {
    await userWithAlert();
    const [a] = await store.claimDueAlerts(T, 10);
    await store.markAlertSent(a!.id, T + 5);
    expect((await store.listAlerts({ limit: 1 }))[0]).toMatchObject({ status: 'sent', sentAt: T + 5, lastError: null });
  });

  it('outbox: interrupted sends become "uncertain", are audited, and are never claimed again', async () => {
    await userWithAlert();
    await store.claimDueAlerts(T, 10); // app "dies" here, before markAlertSent
    expect(await store.recoverInterruptedSends(T + 1)).toBe(1);
    expect((await store.listAlerts({ limit: 1 }))[0]!.status).toBe('uncertain');
    expect(await store.claimDueAlerts(T + 999_999, 10)).toHaveLength(0);
    expect((await store.listAudit(5))[0]!.reason).toMatch(/not resent/);
  });

  it('outbox: a failed send with retry goes back to pending at the retry time; null = give up', async () => {
    await userWithAlert();
    const [a] = await store.claimDueAlerts(T, 10);
    await store.markAlertFailed(a!.id, 'timeout', T + 5_000);
    expect(await store.claimDueAlerts(T + 4_999, 10)).toHaveLength(0);
    const [again] = await store.claimDueAlerts(T + 5_000, 10);
    expect(again).toMatchObject({ attempts: 2, lastError: 'timeout' });
    await store.markAlertFailed(again!.id, 'blocked', null);
    expect((await store.listAlerts({ limit: 1 }))[0]).toMatchObject({ status: 'failed', lastError: 'blocked' });
  });

  it('lists alerts and audit filtered by user', async () => {
    const { user } = await userWithAlert();
    const other = await store.upsertUserByChat('222', DEFAULT_ALERT_SETTINGS, T);
    expect(await store.listAlerts({ userId: other.id, limit: 10 })).toHaveLength(0);
    expect(await store.listAlerts({ userId: user.id, limit: 10 })).toHaveLength(1);
    expect((await store.listAudit(10, { userId: user.id })).length).toBeGreaterThan(0);
    expect(await store.listAudit(10, { userId: other.id })).toHaveLength(0);
  });

  it('persists network health', async () => {
    const h = { network: 'base' as const, lastSuccessAt: T, lastErrorAt: null, lastError: null, consecutiveFailures: 0, lastBlockNumber: 5 };
    await store.saveNetworkHealth([h]);
    await store.saveNetworkHealth([{ ...h, lastBlockNumber: 6 }]);
    expect(await store.loadNetworkHealth()).toEqual([{ ...h, lastBlockNumber: 6 }]);
  });
});

describe.each(FACTORIES)('Persistence across restarts: %s', (_name, open) => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apg-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('data in a database on disk is still there after reopening', async () => {
    const s1 = open(dir);
    await s1.migrate();
    const u = await s1.upsertUserByChat('9', DEFAULT_ALERT_SETTINGS, T);
    await s1.addWallet(u.id, sc.network, sc.wallet, null, T);
    await s1.close();
    const s2 = open(dir);
    await s2.migrate();
    expect(await s2.listWatchedWallets()).toHaveLength(1);
    await s2.close();
  });

  it('end to end: a restart in the middle of the drill causes no duplicate alerts', async () => {
    const T0 = 1_800_000_000_000 - (1_800_000_000_000 % DRILL_CYCLE_MS);
    let now = T0;
    const sent: string[] = [];
    const sender: AlertSender = { send: async (_c, text) => void sent.push(text.split('\n')[0]!) };
    const openApp = async () => {
      const store = open(dir);
      await store.migrate();
      const monitor = new Monitor({ store, source: new SimulatedDataSource({ now: () => now }), now: () => now });
      const dispatcher = new AlertDispatcher({ store, sender, now: () => now });
      await dispatcher.recover();
      return { store, monitor, dispatcher };
    };
    let app = await openApp();
    const u = await app.store.upsertUserByChat('100', DEFAULT_ALERT_SETTINGS, now);
    await app.store.addWallet(u.id, DEMO_SCENARIOS[0]!.network, DEMO_SCENARIOS[0]!.wallet, null, now);
    const run = async (end: number) => {
      for (; now <= end; now += 30_000) {
        await app.monitor.runCycle();
        await app.dispatcher.flush();
      }
    };
    await run(T0 + DRILL_CYCLE_MS * 0.4);
    await app.store.close();
    app = await openApp(); // fresh process, state from the database
    await run(T0 + DRILL_CYCLE_MS);
    await app.store.close();
    expect(sent).toHaveLength(4);
    expect(sent[3]).toMatch(/Recovered/);
  });
});
