// Entry point: database + data source + monitor loop + alert dispatcher + Telegram bot + dashboard API.
import { DEFAULT_ALERT_SETTINGS } from './alerts/settings.js';
import { buildApi, DASHBOARD_DEMO_CHAT_ID, type MonitorStatus } from './api/server.js';
import { loadVerifiedAddresses } from './chain/addresses.js';
import { createViemCaller, type ChainCaller } from './chain/caller.js';
import { NETWORKS, type NetworkKey } from './chain/networks.js';
import { loadConfig } from './config/env.js';
import type { PositionDataSource } from './core/types.js';
import { OnChainDataSource } from './datasources/onchain.js';
import { DEMO_SCENARIOS, SimulatedDataSource } from './datasources/simulated.js';
import { createPgDriver, isPostgresUrl } from './db/pgDriver.js';
import { PostgresStore } from './db/PostgresStore.js';
import { SqliteStore, sqlitePathFromUrl } from './db/SqliteStore.js';
import type { Store } from './db/Store.js';
import { BotService } from './bot/BotService.js';
import { createTelegramBot, registerCommands, telegramSender } from './bot/telegram.js';
import { log } from './lib/log.js';
import { AlertDispatcher, type AlertSender } from './monitor/dispatcher.js';
import { Monitor } from './monitor/monitor.js';

async function main() {
  const config = loadConfig();
  log.info(`Aave Position Guardian starting in ${config.mode.toUpperCase()} mode (read-only, non-custodial)`);

  // SQLite file for development; PostgreSQL (postgres:// URL) for hosting, where the disk is not persistent.
  const store: Store = isPostgresUrl(config.databaseUrl)
    ? new PostgresStore(createPgDriver(config.databaseUrl))
    : new SqliteStore(sqlitePathFromUrl(config.databaseUrl));
  await store.migrate();
  log.info(`Database: ${isPostgresUrl(config.databaseUrl) ? 'PostgreSQL' : 'SQLite file'}`);

  // Data source: simulated in demo mode, on-chain (verified addresses only) in live mode.
  let source: PositionDataSource;
  let networks: NetworkKey[] = config.networks;
  if (config.mode === 'demo') {
    source = new SimulatedDataSource();
  } else {
    const addresses = loadVerifiedAddresses();
    networks = config.networks.filter((n) => addresses[n]);
    const skipped = config.networks.filter((n) => !addresses[n]);
    if (skipped.length) log.warn(`Skipping networks without verified addresses: ${skipped.join(', ')}`);
    const callers: Partial<Record<NetworkKey, ChainCaller>> = {};
    for (const n of networks) callers[n] = createViemCaller({ network: n, multicall3: addresses[n]!.multicall3 });
    source = new OnChainDataSource({ addresses, callers });
  }

  // Demo mode: the dashboard has a built-in watcher of the sample positions, so the public demo
  // shows history and alerts even when nobody uses the Telegram bot. Its alerts go to the dashboard only.
  if (config.mode === 'demo') {
    const u = await store.upsertUserByChat(DASHBOARD_DEMO_CHAT_ID, DEFAULT_ALERT_SETTINGS, Date.now());
    for (const sc of DEMO_SCENARIOS) await store.addWallet(u.id, sc.network, sc.wallet, sc.id, Date.now());
  }

  const service = new BotService({ store, mode: config.mode, networks });
  const bot = config.telegramToken ? createTelegramBot(config.telegramToken, service) : null;
  const telegram: AlertSender = bot
    ? telegramSender(bot)
    : { send: async () => { throw new Error('Telegram is not configured'); } };
  if (!bot) log.warn('TELEGRAM_BOT_TOKEN not set: the bot is off; Telegram alerts cannot be delivered.');
  // Dashboard-only recipients are never sent to Telegram (their alerts are shown in the dashboard).
  const sender: AlertSender = {
    send: async (chatId, text) => (chatId.startsWith('dashboard:') ? undefined : telegram.send(chatId, text)),
  };

  const monitor = new Monitor({ store, source, snapshotRetentionMs: config.snapshotRetentionMs });
  const dispatcher = new AlertDispatcher({ store, sender });
  const uncertain = await dispatcher.recover();
  if (uncertain) log.warn(`${uncertain} alert(s) were interrupted by the last shutdown; marked uncertain, not resent.`);

  const status: MonitorStatus = { lastCycleAt: null, lastCycleError: null };
  const tick = async () => {
    try {
      const r = await monitor.runCycle();
      if (!r.skipped) Object.assign(status, { lastCycleAt: Date.now(), lastCycleError: null });
      if (!r.skipped && r.positions) {
        log.info(`cycle: ${r.positions} position(s) ok=${r.ok} stale=${r.stale} error=${r.error} alerts=${r.alertsQueued} (${r.durationMs} ms)`);
      }
      const f = await dispatcher.flush();
      if (f.sent || f.failed || f.retried || f.expired) log.info(`alerts: sent=${f.sent} retried=${f.retried} failed=${f.failed} expired=${f.expired}`);
    } catch (err) {
      const msg = err instanceof Error ? (err.message.split('\n')[0] ?? 'unknown') : 'unknown';
      status.lastCycleError = msg;
      log.error(`cycle failed: ${msg}`);
    }
  };
  await tick();
  const timer = setInterval(tick, config.pollIntervalMs);

  // Dashboard API
  const rpcSource: Partial<Record<NetworkKey, 'simulated' | 'custom' | 'public'>> = {};
  for (const n of networks) {
    rpcSource[n] = config.mode === 'demo' ? 'simulated' : process.env[NETWORKS[n].rpcEnvVar]?.trim() ? 'custom' : 'public';
  }
  if (config.mode === 'live' && (!config.adminPasswordHash || !config.sessionSecret)) {
    log.warn('Dashboard login not configured (ADMIN_PASSWORD_HASH / SESSION_SECRET): live data endpoints are disabled.');
  }
  const api = await buildApi({
    store,
    mode: config.mode,
    networks,
    pollIntervalMs: config.pollIntervalMs,
    rpcSource,
    adminPasswordHash: config.adminPasswordHash,
    sessionSecret: config.sessionSecret,
    secureCookies: config.secureCookies,
    trustProxy: config.trustProxy,
    monitorStatus: () => status,
  });
  await api.listen({ host: config.apiHost, port: config.apiPort });
  log.info(`Dashboard API listening on http://${config.apiHost}:${config.apiPort}`);

  if (bot) {
    await registerCommands(bot).catch(() => log.warn('could not register bot commands'));
    void bot.start({ onStart: (me) => log.info(`Telegram bot @${me.username} is running`) });
  }

  const shutdown = async (signal: string) => {
    log.info(`${signal}: shutting down`);
    clearInterval(timer);
    await api.close();
    if (bot) await bot.stop();
    await store.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
