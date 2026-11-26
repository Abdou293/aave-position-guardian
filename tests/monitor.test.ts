// End-to-end (offline): simulator → monitor → database outbox → dispatcher → fake Telegram sender.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/settings.js';
import type { PositionDataSource, WatchTarget } from '../src/core/types.js';
import { DEMO_SCENARIOS, DRILL_CYCLE_MS, SimulatedDataSource } from '../src/datasources/simulated.js';
import { SqliteStore } from '../src/db/SqliteStore.js';
import { AlertDispatcher, PermanentSendError, type AlertSender } from '../src/monitor/dispatcher.js';
import { Monitor } from '../src/monitor/monitor.js';

const T0 = 1_800_000_000_000 - (1_800_000_000_000 % DRILL_CYCLE_MS);
const STEP = 15_000;
let dir: string;
let now: number;
const clock = () => now;

class FakeSender implements AlertSender {
  sent: Array<{ chatId: string; text: string }> = [];
  failTimes = 0;
  permanent = false;
  async send(chatId: string, text: string) {
    if (this.permanent) throw new PermanentSendError('user blocked the bot', true);
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error('network timeout');
    }
    this.sent.push({ chatId, text });
  }
}

async function openApp(file: string, sender: AlertSender, source: PositionDataSource = new SimulatedDataSource({ now: clock })) {
  const store = new SqliteStore(file);
  await store.migrate();
  const monitor = new Monitor({ store, source, now: clock });
  const dispatcher = new AlertDispatcher({ store, sender, now: clock });
  await dispatcher.recover();
  return { store, monitor, dispatcher };
}

async function addDemoUser(store: SqliteStore, chatId: string) {
  const u = await store.upsertUserByChat(chatId, DEFAULT_ALERT_SETTINGS, now);
  for (const s of DEMO_SCENARIOS) await store.addWallet(u.id, s.network, s.wallet, s.id, now);
  return u;
}

async function runUntil(app: Awaited<ReturnType<typeof openApp>>, end: number) {
  for (; now <= end; now += STEP) {
    await app.monitor.runCycle();
    await app.dispatcher.flush();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apg-mon-'));
  now = T0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('monitor + dispatcher (end to end, offline)', () => {
  it('one drill cycle delivers exactly 4 alerts to Telegram and stores the HF history', async () => {
    const sender = new FakeSender();
    const app = await openApp(join(dir, 'a.db'), sender);
    await addDemoUser(app.store, '100');
    await runUntil(app, T0 + DRILL_CYCLE_MS);

    expect(sender.sent.map((m) => m.text.split('\n')[0])).toEqual([
      expect.stringMatching(/^⚠️ Warning: health factor .* \(below 1\.5\)/),
      expect.stringMatching(/^⚠️ Warning: health factor .* \(below 1\.25\)/),
      expect.stringMatching(/^🚨 CRITICAL: health factor .* \(below 1\.1\)/),
      expect.stringMatching(/^✅ Recovered/),
    ]);
    const drill = DEMO_SCENARIOS[0]!;
    expect(await app.store.snapshotHistory(drill.network, drill.wallet, 0)).toHaveLength(121);
    expect((await app.store.loadNetworkHealth()).length).toBe(4);
    await app.store.close();
  });

  it('a restart in the middle (state reloaded from the database) causes no duplicate alerts', async () => {
    const file = join(dir, 'b.db');
    const sender = new FakeSender();
    let app = await openApp(file, sender);
    await addDemoUser(app.store, '100');
    await runUntil(app, T0 + DRILL_CYCLE_MS * 0.4); // stop while falling
    const before = sender.sent.length;
    await app.store.close();

    app = await openApp(file, sender, new SimulatedDataSource({ now: clock })); // fresh process
    await runUntil(app, T0 + DRILL_CYCLE_MS);
    expect(before).toBeGreaterThan(0);
    expect(sender.sent).toHaveLength(4);
    await app.store.close();
  });

  it('a crash DURING sending: on restart the alert is marked uncertain and NOT sent twice', async () => {
    const file = join(dir, 'c.db');
    const sender = new FakeSender();
    let app = await openApp(file, sender);
    const u = await app.store.upsertUserByChat('100', DEFAULT_ALERT_SETTINGS, now);
    const drill = DEMO_SCENARIOS[0]!;
    await app.store.addWallet(u.id, drill.network, drill.wallet, null, now);
    now = T0 + DRILL_CYCLE_MS * 0.3; // HF already below 1.5
    await app.monitor.runCycle();
    await app.store.claimDueAlerts(now, 10); // claimed for sending... then the process dies
    await app.store.close();

    app = await openApp(file, sender);
    await app.dispatcher.flush();
    expect(sender.sent).toHaveLength(0);
    expect((await app.store.listAlerts({ limit: 5 }))[0]!.status).toBe('uncertain');
    await app.store.close();
  });

  it('retries a temporary send failure and delivers once', async () => {
    const sender = new FakeSender();
    sender.failTimes = 1;
    const app = await openApp(join(dir, 'd.db'), sender);
    await addDemoUser(app.store, '100');
    await runUntil(app, T0 + DRILL_CYCLE_MS);
    expect(sender.sent).toHaveLength(4);
    await app.store.close();
  });

  it('a user who blocked the bot is deactivated and no longer monitored', async () => {
    const sender = new FakeSender();
    sender.permanent = true;
    const app = await openApp(join(dir, 'e.db'), sender);
    await addDemoUser(app.store, '100');
    await runUntil(app, T0 + DRILL_CYCLE_MS * 0.3);
    expect((await app.store.getUserByChat('100'))!.active).toBe(false);
    expect(await app.store.listWatchedWallets()).toHaveLength(0);
    await app.store.close();
  });

  it('alerts that waited too long (host was asleep) expire instead of arriving late', async () => {
    const sender = new FakeSender();
    const app = await openApp(join(dir, 'f.db'), sender);
    await addDemoUser(app.store, '100');
    now = T0 + DRILL_CYCLE_MS * 0.3;
    await app.monitor.runCycle(); // alert queued, but no flush (host "sleeps")
    now += 45 * 60_000;
    const report = await app.dispatcher.flush();
    expect(report.expired).toBe(1);
    expect(sender.sent).toHaveLength(0);
    await app.store.close();
  });

  it('reads a position watched by two users only once, and both users are alerted', async () => {
    const inner = new SimulatedDataSource({ now: clock });
    const calls: WatchTarget[][] = [];
    const counting: PositionDataSource = {
      kind: 'simulated',
      getNetworkHealth: () => inner.getNetworkHealth(),
      getPositions: (t) => {
        calls.push(t);
        return inner.getPositions(t);
      },
    };
    const sender = new FakeSender();
    const app = await openApp(join(dir, 'g.db'), sender, counting);
    const drill = DEMO_SCENARIOS[0]!;
    for (const chat of ['1', '2']) {
      const u = await app.store.upsertUserByChat(chat, DEFAULT_ALERT_SETTINGS, now);
      await app.store.addWallet(u.id, drill.network, drill.wallet, null, now);
    }
    now = T0 + DRILL_CYCLE_MS * 0.3;
    await app.monitor.runCycle();
    await app.dispatcher.flush();
    expect(calls[0]).toHaveLength(1);
    expect(sender.sent.map((m) => m.chatId).sort()).toEqual(['1', '2']);
    await app.store.close();
  });
});
