// DASHBOARD API (read-only). The Next.js dashboard calls these endpoints through its own /api proxy,
// so the browser only ever talks to one origin (no CORS, SameSite=Strict cookies work).
//
// Demo mode: public, shows only the built-in demo positions (simulated data).
// Live mode: every data endpoint requires the admin login.
// No endpoint can change wallets, settings or anything on-chain. Telegram chat ids are never returned.
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Address } from 'viem';
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from '../alerts/settings.js';
import { NETWORK_NAMES } from '../alerts/format.js';
import { NETWORK_KEYS, type NetworkKey } from '../chain/networks.js';
import { parseWalletAddress } from '../core/address.js';
import type { NetworkHealth } from '../core/types.js';
import type { AlertRow, SnapshotRow, Store } from '../db/Store.js';
import { estimateLiquidationPriceDrop, WHAT_IF_ASSUMPTIONS, WHAT_IF_FORMULA } from '../risk/whatIf.js';
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_MS, verifyPassword, verifySessionToken } from './auth.js';

export const DISCLAIMER =
  'Not financial advice. This tool is read-only and non-custodial. Alerts can be delayed or fail; it cannot guarantee you avoid liquidation. Not audited.';

/** In demo mode the dashboard has its own built-in "user" that watches the sample positions. */
export const DASHBOARD_DEMO_CHAT_ID = 'dashboard:demo';

export interface MonitorStatus {
  lastCycleAt: number | null;
  lastCycleError: string | null;
}

export interface ApiOptions {
  store: Store;
  mode: 'demo' | 'live';
  networks: NetworkKey[];
  pollIntervalMs: number;
  /** Where readings come from, per network (never the URL itself). */
  rpcSource: Partial<Record<NetworkKey, 'simulated' | 'custom' | 'public'>>;
  adminPasswordHash: string | null;
  sessionSecret: string | null;
  /** Send the session cookie only over HTTPS (true when hosted). */
  secureCookies: boolean;
  /** Trust X-Forwarded-For from a reverse proxy (needed for per-IP rate limits behind a proxy). */
  trustProxy?: boolean;
  monitorStatus?: () => MonitorStatus;
  now?: () => number;
  rateLimitPerMinute?: number;
  loginAttemptsPerMinute?: number;
}

const MAX_HISTORY_HOURS = 14 * 24;
const MAX_CHART_POINTS = 400;

export async function buildApi(opts: ApiOptions): Promise<FastifyInstance> {
  const now = opts.now ?? Date.now;
  const { store, mode } = opts;
  const loginConfigured = mode === 'live' && !!opts.adminPasswordHash && !!opts.sessionSecret;

  const app = Fastify({ logger: false, bodyLimit: 4096, trustProxy: opts.trustProxy ?? false });
  await app.register(cookie);
  await app.register(rateLimit, { max: opts.rateLimitPerMinute ?? 120, timeWindow: 60_000 });

  // Security headers. The API only returns JSON, so nothing may be framed or executed.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Never leak internals (stack traces, SQL, RPC URLs) in error responses.
  app.setErrorHandler((err: { statusCode?: number; message?: string }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    void reply.status(status).send({ error: status === 500 ? 'Internal error' : (err.message ?? 'Bad request') });
  });

  const isAuthenticated = (req: FastifyRequest) =>
    mode === 'demo' || (loginConfigured && verifySessionToken(opts.sessionSecret!, req.cookies[SESSION_COOKIE], now()));

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (mode === 'live' && !loginConfigured) {
      return reply.status(503).send({ error: 'Dashboard login is not configured (set ADMIN_PASSWORD_HASH and SESSION_SECRET).' });
    }
    if (!isAuthenticated(req)) return reply.status(401).send({ error: 'Login required' });
  };

  // ---------------------------------------------------------------- public

  app.get('/healthz', async () => {
    const s = opts.monitorStatus?.() ?? { lastCycleAt: null, lastCycleError: null };
    return { ok: true, mode, lastCycleAt: s.lastCycleAt };
  });

  app.get('/api/meta', async (req) => ({
    mode,
    readOnly: true,
    authRequired: mode === 'live',
    loginConfigured,
    authenticated: isAuthenticated(req),
    networks: opts.networks.map((key) => ({ key, name: NETWORK_NAMES[key] })),
    pollIntervalMs: opts.pollIntervalMs,
    disclaimer: DISCLAIMER,
    whatIf: { formula: WHAT_IF_FORMULA, assumptions: WHAT_IF_ASSUMPTIONS },
  }));

  // Failed logins are also limited globally, so changing IP addresses does not help a guesser.
  const failedLogins: number[] = [];
  const GLOBAL_FAIL_WINDOW_MS = 15 * 60_000;
  const GLOBAL_FAIL_LIMIT = 20;

  app.post(
    '/api/login',
    { config: { rateLimit: { max: opts.loginAttemptsPerMinute ?? 5, timeWindow: 60_000 } } },
    async (req, reply) => {
      if (mode !== 'live') return reply.status(400).send({ error: 'Demo mode has no login: the dashboard is public.' });
      if (!loginConfigured) return reply.status(503).send({ error: 'Dashboard login is not configured.' });
      const t = now();
      while (failedLogins.length && failedLogins[0]! < t - GLOBAL_FAIL_WINDOW_MS) failedLogins.shift();
      if (failedLogins.length >= GLOBAL_FAIL_LIMIT) {
        return reply.status(429).send({ error: 'Too many failed logins. Try again later.' });
      }
      const body = req.body as { password?: unknown } | undefined;
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!(await verifyPassword(password, opts.adminPasswordHash!))) {
        failedLogins.push(t);
        return reply.status(401).send({ error: 'Wrong password' });
      }
      void reply.setCookie(SESSION_COOKIE, createSessionToken(opts.sessionSecret!, t), {
        httpOnly: true,
        sameSite: 'strict',
        secure: opts.secureCookies,
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      });
      return { ok: true };
    },
  );

  app.post('/api/logout', async (_req, reply) => {
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- protected (live) / public (demo)

  /** The demo dashboard's built-in user, or null in live mode. */
  const demoUser = async () => (mode === 'demo' ? store.getUserByChat(DASHBOARD_DEMO_CHAT_ID) : null);

  /** Positions visible on the dashboard, with their labels. */
  async function visiblePositions() {
    const map = new Map<string, { network: NetworkKey; address: Address; labels: Set<string>; watchers: number }>();
    const add = (network: NetworkKey, address: Address, label: string | null) => {
      const k = `${network}:${address}`;
      const p = map.get(k) ?? { network, address, labels: new Set<string>(), watchers: 0 };
      if (label) p.labels.add(label);
      p.watchers++;
      map.set(k, p);
    };
    if (mode === 'demo') {
      const u = await demoUser();
      if (u) for (const w of await store.listWallets(u.id)) add(w.network, w.address, w.label);
    } else {
      for (const w of await store.listWatchedWallets()) add(w.network, w.address, w.label);
    }
    return [...map.values()];
  }

  async function settingsForDashboard(): Promise<AlertSettings> {
    return (await demoUser())?.settings ?? DEFAULT_ALERT_SETTINGS;
  }

  app.get('/api/positions', { preHandler: requireAuth }, async () => {
    const t = now();
    const settings = await settingsForDashboard();
    const positions = await Promise.all(
      (await visiblePositions()).map(async (p) => {
        const latest = await store.latestSnapshot(p.network, p.address);
        const lastOk = latest?.status === 'ok' ? latest : await store.latestOkSnapshot(p.network, p.address);
        return {
          network: p.network,
          networkName: NETWORK_NAMES[p.network],
          address: p.address,
          labels: [...p.labels],
          watchers: mode === 'live' ? p.watchers : undefined,
          ...summarize(latest, lastOk, t, settings),
        };
      }),
    );
    // Riskiest first: lowest health factor, positions without debt last.
    positions.sort((a, b) => (a.healthFactor ?? Infinity) - (b.healthFactor ?? Infinity));
    return { at: t, thresholds: settings.thresholds, positions };
  });

  app.get('/api/positions/:network/:address', { preHandler: requireAuth }, async (req, reply) => {
    const params = req.params as { network: string; address: string };
    const query = req.query as { hours?: string };
    if (!NETWORK_KEYS.includes(params.network as NetworkKey)) return reply.status(400).send({ error: 'Unknown network' });
    const network = params.network as NetworkKey;
    const parsed = parseWalletAddress(params.address);
    if (!parsed.ok) return reply.status(400).send({ error: parsed.reason });
    const address = parsed.address;
    const hours = query.hours === undefined ? 24 : Number(query.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HISTORY_HOURS) {
      return reply.status(400).send({ error: `hours must be between 1 and ${MAX_HISTORY_HOURS}` });
    }

    // Only positions that are actually watched can be viewed (no arbitrary lookups).
    const visible = (await visiblePositions()).find((p) => p.network === network && p.address === address);
    if (!visible) return reply.status(404).send({ error: 'This position is not being watched' });

    const t = now();
    const settings = await settingsForDashboard();
    const latest = await store.latestSnapshot(network, address);
    const lastOk = latest?.status === 'ok' ? latest : await store.latestOkSnapshot(network, address);
    const history = await store.snapshotHistory(network, address, t - hours * 3_600_000);
    return {
      network,
      networkName: NETWORK_NAMES[network],
      address,
      labels: [...visible.labels],
      ...summarize(latest, lastOk, t, settings),
      snapshot: lastOk?.snapshot ?? null,
      whatIf: lastOk?.snapshot ? estimateLiquidationPriceDrop(lastOk.snapshot) : null,
      thresholds: settings.thresholds,
      history: downsample(history, MAX_CHART_POINTS, Math.max(3 * opts.pollIntervalMs, 2 * 60_000)),
      historyHours: hours,
    };
  });

  app.get('/api/alerts', { preHandler: requireAuth }, async (req) => {
    const limit = clampInt((req.query as { limit?: string }).limit, 1, 500, 100);
    const u = await demoUser();
    const rows = mode === 'demo' ? (u ? await store.listAlerts({ userId: u.id, limit }) : []) : await store.listAlerts({ limit });
    return { alerts: rows.map(publicAlert) };
  });

  app.get('/api/audit', { preHandler: requireAuth }, async (req) => {
    const limit = clampInt((req.query as { limit?: string }).limit, 1, 500, 100);
    const u = await demoUser();
    const rows = mode === 'demo' ? (u ? await store.listAudit(limit, { userId: u.id }) : []) : await store.listAudit(limit);
    return {
      audit: rows.map((r) => ({ at: r.at, network: r.network, address: r.address, kind: r.kind, decision: r.decision, reason: r.reason })),
    };
  });

  app.get('/api/networks', { preHandler: requireAuth }, async () => {
    const t = now();
    const saved = new Map((await store.loadNetworkHealth()).map((h) => [h.network, h]));
    const s = opts.monitorStatus?.() ?? { lastCycleAt: null, lastCycleError: null };
    return {
      at: t,
      pollIntervalMs: opts.pollIntervalMs,
      monitor: { lastCycleAt: s.lastCycleAt, lastCycleError: s.lastCycleError },
      networks: opts.networks.map((n) => ({
        network: n,
        name: NETWORK_NAMES[n],
        source: opts.rpcSource[n] ?? 'public',
        status: networkStatus(saved.get(n), t, opts.pollIntervalMs),
        ...(saved.get(n) ?? { lastSuccessAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0, lastBlockNumber: null }),
      })),
    };
  });

  return app;
}

// ---------------------------------------------------------------- helpers (exported for tests)

export function summarize(latest: SnapshotRow | null, lastOk: SnapshotRow | null, now: number, settings: AlertSettings) {
  const snap = lastOk?.snapshot ?? null;
  const whatIf = snap ? estimateLiquidationPriceDrop(snap) : null;
  const hf = lastOk?.healthFactor ?? null;
  return {
    /** Status of the LATEST read: ok, stale (showing old data) or error. "none" = never read yet. */
    status: latest ? latest.status : ('none' as const),
    readAt: latest?.at ?? null,
    error: latest && latest.status !== 'ok' ? latest.error : null,
    /** Values below are from the last FRESH reading (dataAt tells how old they are). */
    dataAt: lastOk?.at ?? null,
    dataAgeMs: lastOk ? now - lastOk.at : null,
    hasDebt: snap ? snap.totalDebtUsd > 0 : null,
    healthFactor: hf,
    risk: riskLevel(snap ? hf : undefined, settings.thresholds),
    totalCollateralUsd: lastOk?.totalCollateralUsd ?? null,
    totalDebtUsd: lastOk?.totalDebtUsd ?? null,
    source: snap?.source ?? null,
    whatIfDropFraction: whatIf?.kind === 'estimate' ? whatIf.dropFraction : null,
    whatIfAsset: whatIf?.kind === 'estimate' ? whatIf.asset : null,
  };
}

/** Risk band from the user's own thresholds (sorted high → low). `undefined` = no data. */
export function riskLevel(hf: number | null | undefined, thresholds: number[]) {
  if (hf === undefined) return 'unknown' as const;
  if (hf === null) return 'no-debt' as const;
  if (hf <= 1) return 'liquidatable' as const;
  const sorted = [...thresholds].sort((a, b) => b - a);
  if (hf < sorted[sorted.length - 1]!) return 'critical' as const;
  if (hf < sorted[0]!) return 'warning' as const;
  return 'safe' as const;
}

/**
 * Reduce the history to at most `max` points for the chart. Each bucket keeps its LOWEST health
 * factor (the riskiest moment is never hidden) and marks if any read in it failed.
 * If there is NO reading for longer than `gapMs` (e.g. the host was asleep), a null point is
 * inserted so the chart shows a gap instead of a line through time we did not observe.
 */
export function downsample(rows: SnapshotRow[], max: number, gapMs = Infinity) {
  type Point = { at: number; healthFactor: number | null; ok: boolean };
  const point = (r: SnapshotRow): Point => ({ at: r.at, healthFactor: r.status === 'ok' ? r.healthFactor : null, ok: r.status === 'ok' });

  // Mark unobserved periods first, so downsampling can never bridge them.
  const withGaps: Array<SnapshotRow | null> = [];
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (prev && r.at - prev.at > gapMs) withGaps.push(null);
    withGaps.push(r);
  });
  const gapPoint = (afterAt: number): Point => ({ at: afterAt + 1, healthFactor: null, ok: false });

  if (withGaps.length <= max) {
    return withGaps.map((r, i) => (r ? point(r) : gapPoint(withGaps[i - 1]!.at)));
  }
  const size = Math.ceil(withGaps.length / max);
  const out: Point[] = [];
  for (let i = 0; i < withGaps.length; i += size) {
    const slice = withGaps.slice(i, i + size);
    const real = slice.filter((r): r is SnapshotRow => r !== null).map(point);
    if (real.length === 0) continue;
    const okValues = real.filter((p) => p.ok && p.healthFactor !== null).map((p) => p.healthFactor!);
    const gapInside = slice.includes(null);
    out.push({ at: real[0]!.at, healthFactor: okValues.length ? Math.min(...okValues) : null, ok: real.every((p) => p.ok) });
    if (gapInside) out.push(gapPoint(real[real.length - 1]!.at));
  }
  return out;
}

export function networkStatus(h: NetworkHealth | undefined, now: number, pollMs: number) {
  if (!h || (h.lastSuccessAt === null && h.lastErrorAt === null)) return 'unknown' as const;
  if (h.lastSuccessAt === null || now - h.lastSuccessAt > Math.max(15 * 60_000, 5 * pollMs)) return 'down' as const;
  if (h.consecutiveFailures > 0) return 'degraded' as const;
  return 'ok' as const;
}

function publicAlert(a: AlertRow) {
  // chatId and userId are intentionally NOT included.
  return {
    id: a.id.slice(a.id.indexOf(':') + 1),
    network: a.network,
    address: a.address,
    kind: a.kind,
    severity: a.severity,
    healthFactor: a.healthFactor,
    message: a.message,
    createdAt: a.createdAt,
    status: a.status,
    attempts: a.attempts,
    sentAt: a.sentAt,
    lastError: a.lastError,
  };
}

function clampInt(v: string | undefined, min: number, max: number, dflt: number) {
  const n = v === undefined ? dflt : Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
