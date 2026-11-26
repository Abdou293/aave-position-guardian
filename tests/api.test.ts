import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/settings.js';
import { createSessionToken, hashPassword, verifyPassword, verifySessionToken } from '../src/api/auth.js';
import { buildApi, DASHBOARD_DEMO_CHAT_ID, downsample, networkStatus, riskLevel, type ApiOptions } from '../src/api/server.js';
import { loadConfig } from '../src/config/env.js';
import { DEMO_SCENARIOS, DRILL_CYCLE_MS, SimulatedDataSource } from '../src/datasources/simulated.js';
import type { SnapshotRow } from '../src/db/Store.js';
import { SqliteStore } from '../src/db/SqliteStore.js';
import { Monitor } from '../src/monitor/monitor.js';

const T0 = 1_800_000_000_000 - (1_800_000_000_000 % DRILL_CYCLE_MS);
const PASSWORD = 'correct horse battery staple';
const SECRET = 'x'.repeat(48);
let HASH: string;
let now: number;
let app: FastifyInstance | null = null;
let store: SqliteStore | null = null;

beforeAll(async () => {
  HASH = await hashPassword(PASSWORD);
});
afterEach(async () => {
  await app?.close();
  app = null;
  await store?.close();
  store = null;
});

/** A store with the demo dashboard user + a TELEGRAM user, after `minutes` of monitoring. */
async function setup(mode: 'demo' | 'live', minutes: number, extra: Partial<ApiOptions> = {}) {
  now = T0;
  const s = new SqliteStore(':memory:');
  store = s;
  await s.migrate();
  const dash = await s.upsertUserByChat(DASHBOARD_DEMO_CHAT_ID, DEFAULT_ALERT_SETTINGS, now);
  for (const sc of DEMO_SCENARIOS) await s.addWallet(dash.id, sc.network, sc.wallet, sc.id, now);
  const tg = await s.upsertUserByChat('555000111', DEFAULT_ALERT_SETTINGS, now);
  await s.addWallet(tg.id, DEMO_SCENARIOS[0]!.network, DEMO_SCENARIOS[0]!.wallet, 'telegram user label', now);
  const monitor = new Monitor({ store: s, source: new SimulatedDataSource({ now: () => now }), now: () => now });
  for (const end = T0 + minutes * 60_000; now <= end; now += 30_000) await monitor.runCycle();
  app = await buildApi({
    store: s, mode, networks: ['ethereum', 'arbitrum', 'base', 'polygon'], pollIntervalMs: 30_000,
    rpcSource: { ethereum: 'simulated' }, adminPasswordHash: HASH, sessionSecret: SECRET, secureCookies: true,
    now: () => now, ...extra,
  });
  return app;
}

const get = (url: string, cookie?: string) => app!.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
const login = (password: string) => app!.inject({ method: 'POST', url: '/api/login', payload: { password } });

describe('auth helpers', () => {
  it('hashes passwords with scrypt (salted) and verifies them', async () => {
    expect(HASH).toMatch(/^scrypt:32768:8:1:[\w-]+:[\w-]+$/);
    expect(await hashPassword(PASSWORD)).not.toBe(HASH); // random salt
    expect(await verifyPassword(PASSWORD, HASH)).toBe(true);
    expect(await verifyPassword('wrong password!!', HASH)).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow(/at least 12/);
  });

  it('session tokens: valid, expired, tampered, wrong secret', () => {
    const tok = createSessionToken(SECRET, T0, 1000);
    expect(verifySessionToken(SECRET, tok, T0 + 999)).toBe(true);
    expect(verifySessionToken(SECRET, tok, T0 + 1000)).toBe(false);
    expect(verifySessionToken('y'.repeat(48), tok, T0)).toBe(false);
    const parts = tok.split('.');
    parts[1] = String(T0 + 10 ** 9); // try to extend the expiry
    expect(verifySessionToken(SECRET, parts.join('.'), T0)).toBe(false);
    expect(verifySessionToken(SECRET, undefined, T0)).toBe(false);
  });

  it('config rejects a weak session secret and a malformed hash', () => {
    expect(() => loadConfig({ SESSION_SECRET: 'short-secret' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ADMIN_PASSWORD_HASH: 'plain-password' })).toThrow(/hash:password/);
    expect(loadConfig({ SESSION_SECRET: 'change-me-to-a-long-random-string' }).sessionSecret).toBeNull();
  });
});

describe('API in demo mode (public, simulated data)', () => {
  it('meta: read-only, no login, disclaimer and what-if formula', async () => {
    await setup('demo', 1);
    const m = (await get('/api/meta')).json();
    expect(m).toMatchObject({ mode: 'demo', readOnly: true, authRequired: false, authenticated: true });
    expect(m.disclaimer).toMatch(/Not financial advice.*delayed or fail/);
    expect(m.whatIf.formula).toMatch(/1 − 1\/HF/);
  });

  it('positions: the 4 sample positions, riskiest first, with what-if; never the Telegram user\'s data', async () => {
    await setup('demo', 11); // drill is falling at this point
    const r = await get('/api/positions');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.positions).toHaveLength(4);
    expect(body.positions[0].labels).toEqual(['liquidation-drill']); // not 'telegram user label'
    expect(body.positions[0].risk).toMatch(/warning|critical/);
    expect(body.positions[0].whatIfDropFraction).toBeGreaterThan(0);
    expect(body.positions.at(-1)).toMatchObject({ hasDebt: false, risk: 'no-debt', healthFactor: null });
    expect(r.body).not.toContain('555000111');
    expect(r.body).not.toContain('dashboard:demo');
  });

  it('position detail: history (≤ 400 points), assets and the full what-if with its assumptions', async () => {
    await setup('demo', 30);
    const d = DEMO_SCENARIOS[0]!;
    const r = await get(`/api/positions/${d.network}/${d.wallet.toLowerCase()}?hours=1`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.history.length).toBeGreaterThan(50);
    expect(body.history.length).toBeLessThanOrEqual(400);
    expect(body.snapshot.collateral[0].symbol).toBe('WETH');
    expect(body.whatIf.kind).toBe('estimate');
    expect(body.whatIf.assumptions.length).toBeGreaterThan(2);
  });

  it('position detail: validates input and refuses positions that are not watched', async () => {
    await setup('demo', 1);
    expect((await get(`/api/positions/solana/${DEMO_SCENARIOS[0]!.wallet}`)).statusCode).toBe(400);
    expect((await get('/api/positions/ethereum/0x1234')).statusCode).toBe(400);
    expect((await get(`/api/positions/ethereum/${DEMO_SCENARIOS[0]!.wallet}?hours=99999`)).statusCode).toBe(400);
    const notWatched = '0x92C7B6E8716eaf190406144FaE3BE372561FD0c8';
    expect((await get(`/api/positions/arbitrum/${notWatched}`)).statusCode).toBe(404);
  });

  it('alerts + audit: only the dashboard\'s own alerts, without chat ids', async () => {
    await setup('demo', 16); // past the critical threshold
    const r = await get('/api/alerts');
    const alerts = r.json().alerts;
    expect(alerts.map((a: { severity: string }) => a.severity)).toEqual(['critical', 'warning', 'warning']);
    expect(r.body).not.toContain('555000111');
    expect(alerts[0]).not.toHaveProperty('chatId');
    expect(alerts[0]).not.toHaveProperty('userId');
    const audit = (await get('/api/audit?limit=500')).json().audit;
    expect(audit.some((a: { decision: string }) => a.decision === 'emit')).toBe(true);
  });

  it('networks: per-network status from the monitor', async () => {
    await setup('demo', 1);
    const n = (await get('/api/networks')).json();
    expect(n.networks.map((x: { status: string }) => x.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(n.networks[0].source).toBe('simulated');
  });

  it('login is not available in demo mode', async () => {
    await setup('demo', 0);
    expect((await login(PASSWORD)).statusCode).toBe(400);
  });
});

describe('API in live mode (login required)', () => {
  it('data endpoints require login; meta and healthz stay public', async () => {
    await setup('live', 1);
    for (const url of ['/api/positions', '/api/alerts', '/api/audit', '/api/networks']) {
      expect((await get(url)).statusCode).toBe(401);
    }
    expect((await get('/api/meta')).json()).toMatchObject({ authRequired: true, authenticated: false, loginConfigured: true });
    expect((await get('/healthz')).statusCode).toBe(200);
  });

  it('wrong password → 401; right password → HttpOnly, Secure, SameSite=Strict cookie that unlocks data', async () => {
    await setup('live', 1);
    expect((await login('not the password')).statusCode).toBe(401);
    const ok = await login(PASSWORD);
    expect(ok.statusCode).toBe(200);
    const setCookie = String(ok.headers['set-cookie']);
    expect(setCookie).toMatch(/apg_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;
    const r = await get('/api/positions', cookie);
    expect(r.statusCode).toBe(200);
    // Live mode shows every watched position, with all labels and the watcher count, but no chat ids.
    const drill = r.json().positions.find((p: { address: string }) => p.address === DEMO_SCENARIOS[0]!.wallet);
    expect(drill.watchers).toBe(2);
    expect(r.body).not.toContain('555000111');
    // The session expires.
    now += 13 * 3_600_000;
    expect((await get('/api/positions', cookie)).statusCode).toBe(401);
  });

  it('login is rate-limited per IP (5/min)', async () => {
    await setup('live', 0);
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await login('wrong')).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it('failed logins are also limited globally (changing IP does not help)', async () => {
    await setup('live', 0, { loginAttemptsPerMinute: 1000 });
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await login('wrong')).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes[20]).toBe(429);
    expect((await login(PASSWORD)).statusCode).toBe(429); // locked for the window, even with the right password
  });

  it('without ADMIN_PASSWORD_HASH the live data stays locked (503), never open', async () => {
    await setup('live', 0, { adminPasswordHash: null });
    expect((await get('/api/positions')).statusCode).toBe(503);
    expect((await login(PASSWORD)).statusCode).toBe(503);
  });
});

describe('API hardening', () => {
  it('sends security headers and no-store on every response', async () => {
    await setup('demo', 0);
    const r = await get('/api/meta');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('global rate limit on every endpoint', async () => {
    await setup('demo', 0, { rateLimitPerMinute: 3 });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await get('/api/meta')).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it('rejects oversized request bodies', async () => {
    await setup('live', 0);
    const r = await app!.inject({ method: 'POST', url: '/api/login', payload: { password: 'x'.repeat(10_000) } });
    expect(r.statusCode).toBe(413);
  });
});

describe('API helpers', () => {
  const row = (at: number, hf: number | null, status: SnapshotRow['status'] = 'ok'): SnapshotRow => ({
    network: 'base', address: DEMO_SCENARIOS[0]!.wallet, at, status, healthFactor: hf,
    totalCollateralUsd: null, totalDebtUsd: null, blockNumber: null, snapshot: null, error: null,
  });

  it('downsample keeps the LOWEST health factor of each bucket and marks failed reads', () => {
    const rows = [row(1, 2), row(2, 1.2), row(3, 1.9), row(4, null, 'error'), row(5, 3), row(6, 3)];
    expect(downsample(rows, 2)).toEqual([
      { at: 1, healthFactor: 1.2, ok: true },
      { at: 4, healthFactor: 3, ok: false },
    ]);
    expect(downsample(rows, 10)).toHaveLength(6);
  });

  it('downsample shows a GAP when no reading exists for a while (host asleep), never a bridging line', () => {
    const rows = [row(0, 2), row(30_000, 1.9), row(30 * 60_000, 1.5), row(30 * 60_000 + 30_000, 1.4)];
    const pts = downsample(rows, 400, 120_000);
    expect(pts.map((p) => p.healthFactor)).toEqual([2, 1.9, null, 1.5, 1.4]);
    // Compressed: the gap survives downsampling too.
    const many = [...Array.from({ length: 50 }, (_, i) => row(i * 30_000, 2)), ...Array.from({ length: 50 }, (_, i) => row(3_600_000 + i * 30_000, 1.3))];
    const compressed = downsample(many, 10, 120_000);
    expect(compressed.length).toBeLessThanOrEqual(12);
    expect(compressed.some((p) => p.healthFactor === null)).toBe(true);
  });

  it('riskLevel uses the user thresholds', () => {
    const th = [1.5, 1.25, 1.1];
    expect([2, 1.4, 1.05, 1, null, undefined].map((h) => riskLevel(h, th))).toEqual([
      'safe', 'warning', 'critical', 'liquidatable', 'no-debt', 'unknown',
    ]);
  });

  it('networkStatus: unknown, ok, degraded, down', () => {
    const h = { network: 'base' as const, lastSuccessAt: 1000, lastErrorAt: null, lastError: null, consecutiveFailures: 0, lastBlockNumber: 1 };
    expect(networkStatus(undefined, 2000, 30_000)).toBe('unknown');
    expect(networkStatus(h, 2000, 30_000)).toBe('ok');
    expect(networkStatus({ ...h, consecutiveFailures: 2 }, 2000, 30_000)).toBe('degraded');
    expect(networkStatus(h, 1000 + 16 * 60_000, 30_000)).toBe('down');
  });
});
