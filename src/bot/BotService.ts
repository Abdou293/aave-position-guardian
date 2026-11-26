// All bot command logic, independent of Telegram (so it can be unit-tested).
import { DEFAULT_ALERT_SETTINGS, validateAlertSettings } from '../alerts/settings.js';
import { NETWORK_NAMES, shortAddress } from '../alerts/format.js';
import type { NetworkKey } from '../chain/networks.js';
import { parseWalletAddress } from '../core/address.js';
import { DEMO_SCENARIOS } from '../datasources/simulated.js';
import type { Store, UserRow, WalletRow } from '../db/Store.js';
import { estimateLiquidationPriceDrop } from '../risk/whatIf.js';
import { looksLikeSecret, SECRET_WARNING } from './safety.js';

export interface BotServiceOptions {
  store: Store;
  mode: 'demo' | 'live';
  /** Networks with verified addresses (live) or demo networks. */
  networks: NetworkKey[];
  now?: () => number;
  maxWalletsPerUser?: number;
  /** Max commands per chat per minute. */
  rateLimitPerMinute?: number;
}

export interface BotReply {
  replies: string[];
  /** True when the user's message should be deleted (it looked like a secret). */
  deleteMessage?: boolean;
}

const MIN = 60_000;
const DISCLAIMER = 'Not financial advice. Read-only: this bot never asks for keys and never sends transactions. Alerts can be delayed or fail.';

export const BOT_COMMANDS = [
  { command: 'start', description: 'Start and see how it works' },
  { command: 'add', description: 'Watch a wallet: /add <network> <address> [label]' },
  { command: 'remove', description: 'Stop watching: /remove <number from /list>' },
  { command: 'list', description: 'Your watched wallets' },
  { command: 'status', description: 'Current health factor of each position' },
  { command: 'thresholds', description: 'Show or set alert thresholds, e.g. /thresholds 1.5 1.25 1.1' },
  { command: 'settings', description: 'Show your alert settings' },
  { command: 'pause', description: 'Mute alerts, e.g. /pause 2h' },
  { command: 'resume', description: 'Unmute alerts' },
  { command: 'networks', description: 'Data source health per network' },
  { command: 'demo', description: 'Demo mode: watch the sample positions' },
  { command: 'help', description: 'All commands' },
] as const;

export class BotService {
  private readonly now: () => number;
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly opts: BotServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  async handle(chatId: string, text: string): Promise<BotReply> {
    // Safety first: never process or store anything that looks like a secret.
    if (looksLikeSecret(text)) return { replies: [SECRET_WARNING], deleteMessage: true };
    if (!this.allow(chatId)) return { replies: ['Too many commands. Please wait a minute.'] };

    const [rawCmd = '', ...args] = text.trim().split(/\s+/);
    if (!rawCmd.startsWith('/')) return { replies: ['Send /help to see the commands.'] };
    const cmd = rawCmd.slice(1).split('@')[0]!.toLowerCase();

    const user = await this.opts.store.upsertUserByChat(chatId, DEFAULT_ALERT_SETTINGS, this.now());
    switch (cmd) {
      case 'start': return this.reply(this.welcome());
      case 'help': return this.reply(this.help());
      case 'add': return this.reply(await this.add(user, args));
      case 'remove': return this.reply(await this.remove(user, args));
      case 'list': return this.reply(await this.list(user));
      case 'status': return this.reply(await this.status(user));
      case 'thresholds': return this.reply(await this.thresholds(user, args));
      case 'settings': return this.reply(this.settings(user));
      case 'pause': return this.reply(await this.pause(user, args));
      case 'resume': return this.reply(await this.resume(user));
      case 'networks': return this.reply(await this.networksHealth());
      case 'demo': return this.reply(await this.demo(user));
      default: return this.reply(`Unknown command /${cmd}. Send /help.`);
    }
  }

  private reply(...replies: string[]): BotReply {
    return { replies };
  }

  /** Sliding window rate limit per chat. */
  private allow(chatId: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(chatId) ?? []).filter((t) => now - t < MIN);
    if (recent.length >= (this.opts.rateLimitPerMinute ?? 20)) {
      this.hits.set(chatId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(chatId, recent);
    return true;
  }

  // ------------------------------------------------------------------ commands

  private welcome(): string {
    const demo = this.opts.mode === 'demo'
      ? '\n\n🧪 DEMO MODE: data is simulated (no real wallets). Send /demo to watch the sample positions, including one that drops toward liquidation and recovers every 30 minutes.'
      : '';
    return `🛡️ Aave Position Guardian\nEarly warnings for Aave V3 borrowers. I watch the health factor of the wallets you add and message you before liquidation risk grows.${demo}\n\n${this.help()}`;
  }

  private help(): string {
    return [
      ...BOT_COMMANDS.map((c) => `/${c.command}: ${c.description}`),
      `Networks: ${this.opts.networks.join(', ')}`,
      '',
      DISCLAIMER,
    ].join('\n');
  }

  private async add(user: UserRow, args: string[]): Promise<string> {
    const [networkArg, addressArg, ...labelParts] = args;
    if (!networkArg || !addressArg) return `Usage: /add <network> <address> [label]\nNetworks: ${this.opts.networks.join(', ')}`;
    const network = networkArg.toLowerCase() as NetworkKey;
    if (!this.opts.networks.includes(network)) return `Unsupported network "${networkArg}". Use one of: ${this.opts.networks.join(', ')}`;
    const parsed = parseWalletAddress(addressArg);
    if (!parsed.ok) return `Invalid address: ${parsed.reason}`;
    if (this.opts.mode === 'demo' && !DEMO_SCENARIOS.some((s) => s.network === network && s.wallet === parsed.address)) {
      return 'Demo mode only watches the sample wallets. Send /demo to add them.';
    }
    const wallets = await this.opts.store.listWallets(user.id);
    if (wallets.length >= (this.opts.maxWalletsPerUser ?? 20)) return `Limit reached (${this.opts.maxWalletsPerUser ?? 20} wallets). Remove one first.`;
    const label = labelParts.join(' ').replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 32) || null;
    const added = await this.opts.store.addWallet(user.id, network, parsed.address, label, this.now());
    if (!added) return `Already watching ${shortAddress(parsed.address)} on ${NETWORK_NAMES[network]}.`;
    return `👀 Now watching ${parsed.address} on ${NETWORK_NAMES[network]}${label ? ` (${label})` : ''}.\nThe first reading arrives with the next check. Use /status.`;
  }

  private async remove(user: UserRow, args: string[]): Promise<string> {
    const wallets = await this.opts.store.listWallets(user.id);
    let target: WalletRow | undefined;
    if (args.length === 1 && /^\d+$/.test(args[0]!)) {
      target = wallets[Number(args[0]) - 1];
    } else if (args.length === 2) {
      const parsed = parseWalletAddress(args[1]!);
      target = parsed.ok ? wallets.find((w) => w.network === args[0]!.toLowerCase() && w.address === parsed.address) : undefined;
    } else {
      return 'Usage: /remove <number from /list>  or  /remove <network> <address>';
    }
    if (!target) return 'No such wallet in your list. See /list.';
    await this.opts.store.removeWallet(user.id, target.network, target.address);
    return `🗑️ Stopped watching ${shortAddress(target.address)} on ${NETWORK_NAMES[target.network]}.`;
  }

  private async list(user: UserRow): Promise<string> {
    const wallets = await this.opts.store.listWallets(user.id);
    if (!wallets.length) return this.opts.mode === 'demo' ? 'No wallets yet. Send /demo to add the sample positions.' : 'No wallets yet. Use /add <network> <address>.';
    return ['Your watched wallets:', ...wallets.map((w, i) => `${i + 1}. ${NETWORK_NAMES[w.network]} · ${w.address}${w.label ? ` (${w.label})` : ''}`)].join('\n');
  }

  private async status(user: UserRow): Promise<string> {
    const wallets = await this.opts.store.listWallets(user.id);
    if (!wallets.length) return 'No wallets yet. See /help.';
    const blocks: string[] = [];
    for (const w of wallets) {
      const head = `${NETWORK_NAMES[w.network]} · ${shortAddress(w.address)}${w.label ? ` (${w.label})` : ''}`;
      const snap = await this.opts.store.latestSnapshot(w.network, w.address);
      if (!snap) {
        blocks.push(`${head}\n⏳ No reading yet.`);
        continue;
      }
      const age = Math.round((this.now() - snap.at) / 1000);
      if (snap.status !== 'ok' || !snap.snapshot) {
        blocks.push(`${head}\n⚠️ Latest read failed ${age}s ago (${snap.error ?? snap.status}). Values may be out of date.`);
        continue;
      }
      const s = snap.snapshot;
      const hf = s.healthFactor === null ? 'no debt ✅' : `${s.healthFactor.toFixed(3)} ${riskIcon(s.healthFactor, user.settings.thresholds)}`;
      const lines = [
        head,
        `Health factor: ${hf}`,
        `Collateral $${fmtUsd(s.totalCollateralUsd)} · Debt $${fmtUsd(s.totalDebtUsd)}`,
        `Liq. threshold ${(s.liquidationThreshold * 100).toFixed(1)}% · LTV ${(s.ltv * 100).toFixed(1)}%`,
      ];
      const whatIf = estimateLiquidationPriceDrop(s);
      if (whatIf.kind === 'estimate' || whatIf.kind === 'not-reachable') lines.push(whatIf.message);
      lines.push(`Updated ${age}s ago${s.source === 'simulated' ? ' (simulated data)' : ''}.`);
      blocks.push(lines.join('\n'));
    }
    const paused = user.settings.pausedUntil && user.settings.pausedUntil > this.now() ? `\n🔕 Alerts paused until ${iso(user.settings.pausedUntil)}.` : '';
    return `${blocks.join('\n\n')}${paused}\n\nNot financial advice.`;
  }

  private async thresholds(user: UserRow, args: string[]): Promise<string> {
    if (!args.length) return `Current thresholds: ${user.settings.thresholds.join(', ')} (the last one is critical).\nChange: /thresholds 1.5 1.25 1.1`;
    const values = args.map(Number);
    const v = validateAlertSettings({ thresholds: values }, user.settings);
    if (!v.ok) return `Not saved: ${v.errors.join(' ')}`;
    await this.opts.store.updateUserSettings(user.id, v.settings);
    return `✅ Thresholds saved: ${v.settings.thresholds.join(', ')} (critical: ${v.settings.thresholds.at(-1)}).`;
  }

  private settings(user: UserRow): string {
    const s = user.settings;
    const min = (ms: number) => `${Math.round(ms / MIN)} min`;
    return [
      'Alert settings:',
      `• Thresholds: ${s.thresholds.join(', ')} (last = critical)`,
      `• Hysteresis: +${s.hysteresis} (a level clears only above threshold + ${s.hysteresis})`,
      `• Cooldown per level: ${min(s.cooldownMs)}`,
      `• Critical reminder: every ${min(s.criticalRepeatMs)}, or sooner if HF falls by ${s.criticalWorsenDelta}`,
      `• "Monitoring degraded" warning after ${min(s.dataProblemAfterMs)} without fresh data`,
      `• Paused: ${s.pausedUntil && s.pausedUntil > this.now() ? `until ${iso(s.pausedUntil)}` : 'no'}`,
    ].join('\n');
  }

  private async pause(user: UserRow, args: string[]): Promise<string> {
    const ms = parseDuration(args[0] ?? '1h');
    if (ms === null || ms < 5 * MIN || ms > 7 * 24 * 60 * MIN) return 'Usage: /pause 30m | 2h | 1d (between 5 minutes and 7 days).';
    const until = this.now() + ms;
    await this.opts.store.updateUserSettings(user.id, { ...user.settings, pausedUntil: until });
    return `🔕 Alerts paused until ${iso(until)}. Monitoring continues. Critical reminders resume when the pause ends. /resume to unmute now.`;
  }

  private async resume(user: UserRow): Promise<string> {
    await this.opts.store.updateUserSettings(user.id, { ...user.settings, pausedUntil: null });
    return '🔔 Alerts resumed.';
  }

  private async networksHealth(): Promise<string> {
    const health = await this.opts.store.loadNetworkHealth();
    const rows = this.opts.networks.map((n) => {
      const h = health.find((x) => x.network === n);
      if (!h || (h.lastSuccessAt === null && h.lastErrorAt === null)) return `${NETWORK_NAMES[n]}: no reads yet`;
      const ok = h.consecutiveFailures === 0;
      const last = h.lastSuccessAt ? `last success ${Math.round((this.now() - h.lastSuccessAt) / 1000)}s ago` : 'never succeeded';
      return `${ok ? '🟢' : '🔴'} ${NETWORK_NAMES[n]}: ${last}${ok ? '' : `, ${h.consecutiveFailures} failure(s): ${h.lastError}`}`;
    });
    return ['Data source health:', ...rows].join('\n');
  }

  private async demo(user: UserRow): Promise<string> {
    if (this.opts.mode !== 'demo') return 'Demo wallets are only available in demo mode.';
    let added = 0;
    for (const sc of DEMO_SCENARIOS) {
      if (await this.opts.store.addWallet(user.id, sc.network, sc.wallet, sc.id, this.now())) added++;
    }
    return `🧪 Added ${added} sample position(s):\n${DEMO_SCENARIOS.map((s) => `• ${NETWORK_NAMES[s.network]}: ${s.label}`).join('\n')}\nAlerts for the liquidation drill arrive over the next minutes. Use /status anytime.`;
  }
}

// ------------------------------------------------------------------ helpers

function riskIcon(hf: number, thresholds: number[]): string {
  if (hf <= 1) return '🚨 LIQUIDATABLE';
  if (hf < thresholds.at(-1)!) return '🚨';
  if (hf < thresholds[0]!) return '⚠️';
  return '✅';
}

const fmtUsd = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** "30m" | "2h" | "1d" → milliseconds, or null. */
export function parseDuration(text: string): number | null {
  const m = /^(\d{1,4})([mhd])$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n * { m: MIN, h: 60 * MIN, d: 24 * 60 * MIN }[m[2]!.toLowerCase() as 'm' | 'h' | 'd'];
}
