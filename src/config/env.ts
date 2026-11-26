// Reads and validates configuration from environment variables (.env in development).
import { isValidPasswordHash, MIN_SESSION_SECRET_LENGTH } from '../api/auth.js';
import { NETWORK_KEYS, type NetworkKey } from '../chain/networks.js';

export interface AppConfig {
  mode: 'demo' | 'live';
  telegramToken: string | null;
  databaseUrl: string;
  pollIntervalMs: number;
  snapshotRetentionMs: number;
  /** Networks to monitor (live mode: must also have verified addresses). */
  networks: NetworkKey[];
  /** Dashboard API */
  apiHost: string;
  apiPort: number;
  adminPasswordHash: string | null;
  sessionSecret: string | null;
  secureCookies: boolean;
  trustProxy: boolean;
}

const PLACEHOLDER = /^(|your-.*|change-me.*)$/i;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = [];

  const mode = (env.APP_MODE ?? 'demo').trim().toLowerCase();
  if (mode !== 'demo' && mode !== 'live') errors.push('APP_MODE must be "demo" or "live".');

  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const telegramToken = PLACEHOLDER.test(token) ? null : token;
  if (telegramToken && !/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(telegramToken)) {
    errors.push('TELEGRAM_BOT_TOKEN does not look like a bot token from @BotFather.');
  }

  const defaultPoll = mode === 'demo' ? 30_000 : 60_000;
  const pollIntervalMs = Number(env.POLL_INTERVAL_MS ?? defaultPoll);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 15_000) errors.push('POLL_INTERVAL_MS must be at least 15000 (free RPC limits).');

  const retentionDays = Number(env.SNAPSHOT_RETENTION_DAYS ?? 14);
  if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 365) errors.push('SNAPSHOT_RETENTION_DAYS must be 1–365.');

  const networks = (env.NETWORKS?.trim() ? env.NETWORKS.split(',') : NETWORK_KEYS).map((n) => n.trim().toLowerCase());
  const unknown = networks.filter((n) => !NETWORK_KEYS.includes(n as NetworkKey));
  if (unknown.length) errors.push(`Unknown network(s) in NETWORKS: ${unknown.join(', ')}`);

  const apiPort = Number(env.PORT ?? env.API_PORT ?? 4000);
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) errors.push('PORT / API_PORT must be a valid port number.');

  const rawHash = env.ADMIN_PASSWORD_HASH?.trim() ?? '';
  const adminPasswordHash = rawHash ? rawHash : null;
  if (adminPasswordHash && !isValidPasswordHash(adminPasswordHash)) {
    errors.push('ADMIN_PASSWORD_HASH is not a valid hash. Generate it with: npm run hash:password');
  }
  const rawSecret = env.SESSION_SECRET?.trim() ?? '';
  const sessionSecret = PLACEHOLDER.test(rawSecret) ? null : rawSecret;
  if (sessionSecret && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    errors.push(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} random characters.`);
  }

  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);

  return {
    mode: mode as AppConfig['mode'],
    telegramToken,
    databaseUrl: env.DATABASE_URL?.trim() || 'file:./data/guardian.db',
    pollIntervalMs,
    snapshotRetentionMs: retentionDays * 24 * 60 * 60_000,
    networks: networks as NetworkKey[],
    apiHost: env.API_HOST?.trim() || (env.PORT ? '0.0.0.0' : '127.0.0.1'),
    apiPort,
    adminPasswordHash,
    sessionSecret,
    secureCookies: (env.COOKIE_SECURE ?? (env.NODE_ENV === 'production' ? 'true' : 'false')).trim() === 'true',
    trustProxy: env.TRUST_PROXY?.trim() === 'true',
  };
}
