import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotService, parseDuration } from '../src/bot/BotService.js';
import { looksLikeSecret } from '../src/bot/safety.js';
import { loadConfig } from '../src/config/env.js';
import { DEMO_SCENARIOS, simulatePosition } from '../src/datasources/simulated.js';
import { SqliteStore } from '../src/db/SqliteStore.js';

const T = 1_800_000_000_000;
const REAL = '0x92C7B6E8716eaf190406144FaE3BE372561FD0c8';
let store: SqliteStore;
let now: number;

const svc = (mode: 'demo' | 'live' = 'live', extra = {}) =>
  new BotService({ store, mode, networks: ['ethereum', 'arbitrum', 'base', 'polygon'], now: () => now, ...extra });
const text = async (s: BotService, msg: string, chat = '1') => (await s.handle(chat, msg)).replies.join('\n');

beforeEach(async () => {
  now = T;
  store = new SqliteStore(':memory:');
  await store.migrate();
});
afterEach(() => store.close());

describe('bot: safety', () => {
  it('detects private keys and seed phrases, warns, asks to delete, and stores nothing', async () => {
    const key = `0x${'ab'.repeat(32)}`;
    const seed = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    for (const secret of [key, `/add ethereum ${key}`, seed]) {
      const r = await svc().handle('1', secret);
      expect(r.deleteMessage).toBe(true);
      expect(r.replies[0]).toMatch(/NEVER needs it/);
    }
    expect(await store.getUserByChat('1')).toBeNull();
  });

  it('does not flag normal addresses or commands', () => {
    expect(looksLikeSecret(`/add arbitrum ${REAL}`)).toBe(false);
    expect(looksLikeSecret('/thresholds 1.5 1.25 1.1')).toBe(false);
  });

  it('rate-limits a chat that sends too many commands', async () => {
    const s = svc('live', { rateLimitPerMinute: 3 });
    for (let i = 0; i < 3; i++) await s.handle('1', '/help');
    expect(await text(s, '/help')).toMatch(/Too many commands/);
    now += 61_000;
    expect(await text(s, '/help')).not.toMatch(/Too many/);
  });
});

describe('bot: wallets', () => {
  it('/start explains read-only mode and the disclaimer', async () => {
    const t = await text(svc(), '/start');
    expect(t).toMatch(/never asks for keys/);
    expect(t).toMatch(/Not financial advice/);
  });

  it('/add validates network and address (including checksum typos)', async () => {
    const s = svc();
    expect(await text(s, '/add')).toMatch(/Usage/);
    expect(await text(s, `/add solana ${REAL}`)).toMatch(/Unsupported network/);
    expect(await text(s, '/add ethereum 0x1234')).toMatch(/Invalid address/);
    expect(await text(s, `/add ethereum ${REAL.replace('C7', 'c7')}`)).toMatch(/Checksum/);
  });

  it('/add, /list, duplicate, /remove by number', async () => {
    const s = svc();
    expect(await text(s, `/add arbitrum ${REAL.toLowerCase()} My vault`)).toMatch(/Now watching 0x92C7B6E8716eaf190406144FaE3BE372561FD0c8 on Arbitrum \(My vault\)/);
    expect(await text(s, `/add arbitrum ${REAL}`)).toMatch(/Already watching/);
    expect(await text(s, '/list')).toMatch(/1\. Arbitrum · 0x92C7/);
    expect(await text(s, '/remove 1')).toMatch(/Stopped watching/);
    expect(await text(s, '/list')).toMatch(/No wallets yet/);
  });

  it('enforces the per-user wallet limit', async () => {
    const s = svc('live', { maxWalletsPerUser: 1 });
    await s.handle('1', `/add arbitrum ${REAL}`);
    expect(await text(s, `/add base ${REAL}`)).toMatch(/Limit reached/);
  });

  it('demo mode: only sample wallets, and /demo adds all of them', async () => {
    const s = svc('demo');
    expect(await text(s, `/add arbitrum ${REAL}`)).toMatch(/only watches the sample wallets/);
    expect(await text(s, '/demo')).toMatch(/Added 4 sample position/);
    expect(await text(s, '/demo')).toMatch(/Added 0 sample/);
  });
});

describe('bot: status and settings', () => {
  it('/status shows HF, amounts, a what-if estimate and data age', async () => {
    const s = svc('demo');
    await s.handle('1', '/demo');
    const sc = DEMO_SCENARIOS.find((x) => x.id === 'steady')!;
    const snap = simulatePosition(sc, T);
    await store.insertSnapshots([{ network: sc.network, address: sc.wallet, at: T - 20_000, status: 'ok', healthFactor: snap.healthFactor,
      totalCollateralUsd: snap.totalCollateralUsd, totalDebtUsd: snap.totalDebtUsd, blockNumber: 1, snapshot: snap, error: null }]);
    const t = await text(s, '/status');
    expect(t).toMatch(/Arbitrum · 0xDE30…0002 \(steady\)\nHealth factor: 2\.\d{3} ✅/i);
    expect(t).toMatch(/Estimate: a fall of about/);
    expect(t).toMatch(/Updated 20s ago \(simulated data\)/);
    expect(t).toMatch(/No reading yet/); // the other demo wallets
  });

  it('/thresholds shows, saves valid values and rejects invalid ones', async () => {
    const s = svc();
    expect(await text(s, '/thresholds')).toMatch(/1\.5, 1\.25, 1\.1/);
    expect(await text(s, '/thresholds 1.3 2 1.05')).toMatch(/saved: 2, 1\.3, 1\.05/);
    expect(await text(s, '/thresholds 0.5')).toMatch(/Not saved/);
    expect((await store.getUserByChat('1'))!.settings.thresholds).toEqual([2, 1.3, 1.05]);
  });

  it('/pause and /resume', async () => {
    const s = svc();
    expect(await text(s, '/pause 2h')).toMatch(/paused until/);
    expect((await store.getUserByChat('1'))!.settings.pausedUntil).toBe(T + 2 * 3_600_000);
    expect(await text(s, '/pause 1m')).toMatch(/Usage/);
    await s.handle('1', '/resume');
    expect((await store.getUserByChat('1'))!.settings.pausedUntil).toBeNull();
  });

  it('parses durations', () => {
    expect([parseDuration('30m'), parseDuration('2h'), parseDuration('1d'), parseDuration('x')]).toEqual([1_800_000, 7_200_000, 86_400_000, null]);
  });
});

describe('config', () => {
  it('defaults to demo mode and treats the .env.example placeholder token as "not set"', () => {
    const c = loadConfig({ TELEGRAM_BOT_TOKEN: 'your-telegram-bot-token-here' });
    expect(c.mode).toBe('demo');
    expect(c.telegramToken).toBeNull();
  });

  it('rejects unsafe or invalid settings', () => {
    expect(() => loadConfig({ APP_MODE: 'prod' })).toThrow(/APP_MODE/);
    expect(() => loadConfig({ POLL_INTERVAL_MS: '1000' })).toThrow(/POLL_INTERVAL_MS/);
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: 'abc' })).toThrow(/BotFather/);
    expect(() => loadConfig({ NETWORKS: 'ethereum,solana' })).toThrow(/solana/);
  });
});
