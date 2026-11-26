// Dashboard authentication (live mode only).
//
// - The admin password is NEVER stored: only a scrypt hash (memory-hard, salted) in ADMIN_PASSWORD_HASH.
// - A login creates a signed, expiring session token (HMAC-SHA256 with SESSION_SECRET), stored in an
//   HttpOnly, SameSite=Strict cookie. Changing SESSION_SECRET logs everybody out.
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );

const KEY_LEN = 32;
const DEFAULT = { N: 2 ** 15, r: 8, p: 1 };
const MAXMEM = 128 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 12;

/** Format: scrypt:N:r:p:<salt base64url>:<hash base64url> (no `$`, so it is safe in .env files). */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { ...DEFAULT, maxmem: MAXMEM });
  return ['scrypt', DEFAULT.N, DEFAULT.r, DEFAULT.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

export function isValidPasswordHash(stored: string): boolean {
  return parseHash(stored) !== null;
}

function parseHash(stored: string) {
  const parts = stored.trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  // Bounds stop a bad config value from making every login burn the CPU.
  if (!Number.isInteger(Math.log2(N)) || N < 2 ** 14 || N > 2 ** 17 || r < 1 || r > 16 || p < 1 || p > 4) return null;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const hash = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < 16 || hash.length !== KEY_LEN) return null;
  return { N, r, p, salt, hash };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parseHash(stored);
  if (!h || password.length === 0 || password.length > 256) return false;
  const key = await scrypt(password, h.salt, KEY_LEN, { N: h.N, r: h.r, p: h.p, maxmem: MAXMEM });
  return timingSafeEqual(key, h.hash);
}

// ------------------------------------------------------------------ sessions

export const SESSION_COOKIE = 'apg_session';
export const SESSION_TTL_MS = 12 * 60 * 60_000;
export const MIN_SESSION_SECRET_LENGTH = 32;

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export function createSessionToken(secret: string, now: number, ttlMs = SESSION_TTL_MS): string {
  const payload = `v1.${now + ttlMs}.${randomBytes(12).toString('base64url')}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySessionToken(secret: string, token: string | undefined, now: number): boolean {
  if (!token || token.length > 200) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const given = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(secret, payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const [version, exp] = payload.split('.');
  return version === 'v1' && Number(exp) > now;
}
