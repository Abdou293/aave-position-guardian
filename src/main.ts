// Entry point: database + data source + monitor loop + alert dispatcher + Telegram bot.
import { loadVerifiedAddresses } from './chain/addresses.js';
import { createViemCaller, type ChainCaller } from './chain/caller.js';
import type { NetworkKey } from './chain/networks.js';
import { loadConfig } from './config/env.js';
import type { PositionDataSource } from './core/types.js';
import { OnChainDataSource } from './datasources/onchain.js';
import { SimulatedDataSource } from './datasources/simulated.js';
import { SqliteStore, sqlitePathFromUrl } from './db/SqliteStore.js';
import { BotService } from './bot/BotService.js';
import { createTelegramBot, registerCommands, telegramSender } from './bot/telegram.js';
import { log } from './lib/log.js';
import { AlertDispatcher, type AlertSender } from './monitor/dispatcher.js';
import { Monitor } from './monitor/monitor.js';

async function main() {
  const config = loadConfig();
  log.info(`Aave Position Guardian starting in ${config.mode.toUpperCase()} mode (read-only, non-custodial)`);

  const store = new SqliteStore(sqlitePathFromUrl(config.databaseUrl));
  await store.migrate();

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

  const service = new BotService({ store, mode: config.mode, networks });
  const bot = config.telegramToken ? createTelegramBot(config.telegramToken, service) : null;
  const sender: AlertSender = bot
    ? telegramSender(bot)
    : { send: async () => { throw new Error('Telegram is not configured'); } };
  if (!bot) log.warn('TELEGRAM_BOT_TOKEN not set: the bot is off; alerts stay in the database outbox.');

  const monitor = new Monitor({ store, source, snapshotRetentionMs: config.snapshotRetentionMs });
  const dispatcher = new AlertDispatcher({ store, sender });
  const uncertain = await dispatcher.recover();
  if (uncertain) log.warn(`${uncertain} alert(s) were interrupted by the last shutdown; marked uncertain, not resent.`);

  const tick = async () => {
    try {
      const r = await monitor.runCycle();
      if (!r.skipped && r.positions) {
        log.info(`cycle: ${r.positions} position(s) ok=${r.ok} stale=${r.stale} error=${r.error} alerts=${r.alertsQueued} (${r.durationMs} ms)`);
      }
      if (bot) {
        const f = await dispatcher.flush();
        if (f.sent || f.failed || f.retried || f.expired) log.info(`alerts: sent=${f.sent} retried=${f.retried} failed=${f.failed} expired=${f.expired}`);
      }
    } catch (err) {
      log.error(`cycle failed: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`);
    }
  };
  await tick();
  const timer = setInterval(tick, config.pollIntervalMs);

  if (bot) {
    await registerCommands(bot).catch(() => log.warn('could not register bot commands'));
    void bot.start({ onStart: (me) => log.info(`Telegram bot @${me.username} is running`) });
  }

  const shutdown = async (signal: string) => {
    log.info(`${signal}: shutting down`);
    clearInterval(timer);
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
