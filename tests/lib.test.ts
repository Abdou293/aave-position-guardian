import { describe, expect, it } from 'vitest';
import { parseWalletAddress } from '../src/core/address.js';
import { RateLimiter } from '../src/lib/rateLimiter.js';
import { withRetry } from '../src/lib/retry.js';
import { TtlCache } from '../src/lib/ttlCache.js';

describe('parseWalletAddress', () => {
  const checksummed = '0x92C7B6E8716eaf190406144FaE3BE372561FD0c8';

  it('accepts a valid checksummed address', () => {
    expect(parseWalletAddress(checksummed)).toEqual({ ok: true, address: checksummed });
  });
  it('accepts all-lowercase and returns the checksum form', () => {
    expect(parseWalletAddress(checksummed.toLowerCase())).toEqual({ ok: true, address: checksummed });
  });
  it('trims spaces around the input', () => {
    expect(parseWalletAddress(`  ${checksummed}\n`)).toMatchObject({ ok: true });
  });
  it('rejects a mixed-case address with a wrong checksum (likely typo)', () => {
    const typo = checksummed.replace('C7', 'c7');
    expect(parseWalletAddress(typo)).toMatchObject({ ok: false, reason: expect.stringMatching(/checksum/i) });
  });
  it('rejects wrong length, missing 0x, non-hex and the zero address', () => {
    for (const bad of ['0x1234', checksummed.slice(2), '0xZZ' + checksummed.slice(4), '0x' + '0'.repeat(40), '']) {
      expect(parseWalletAddress(bad).ok).toBe(false);
    }
  });
});

describe('withRetry', () => {
  const noSleep = async () => {};

  it('succeeds after transient failures', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      if (++calls < 3) throw new Error('flaky');
      return 'ok';
    }, { retries: 2, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the retry budget and throws the last error', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('down');
      }, { retries: 2, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep }),
    ).rejects.toThrow('down');
    expect(calls).toBe(3);
  });

  it('stops early when shouldRetry says no', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('permanent');
      }, { retries: 5, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep, shouldRetry: () => false }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('backs off exponentially, capped at maxDelayMs', async () => {
    const waits: number[] = [];
    await withRetry(async (attempt) => {
      if (attempt < 4) throw new Error('x');
    }, { retries: 4, baseDelayMs: 100, maxDelayMs: 500, sleep: async (ms) => void waits.push(ms), random: () => 1 });
    expect(waits).toEqual([100, 200, 400, 500]);
  });
});

describe('RateLimiter', () => {
  it('starts tasks at least minIntervalMs apart', async () => {
    let now = 0;
    const starts: number[] = [];
    const rl = new RateLimiter({ minIntervalMs: 250, now: () => now, sleep: async (ms) => void (now += ms) });
    for (let i = 0; i < 4; i++) await rl.schedule(async () => void starts.push(now));
    expect(starts).toEqual([0, 250, 500, 750]);
  });
});

describe('TtlCache', () => {
  it('expires values after the TTL', () => {
    let now = 0;
    const c = new TtlCache<number>(() => now);
    c.set('a', 1, 1000);
    expect(c.get('a')).toBe(1);
    now = 1000;
    expect(c.get('a')).toBeUndefined();
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const c = new TtlCache<number>();
    let loads = 0;
    const load = async () => {
      loads++;
      return 42;
    };
    const [a, b] = await Promise.all([c.getOrLoad('k', 1000, load), c.getOrLoad('k', 1000, load)]);
    expect([a, b, loads]).toEqual([42, 42, 1]);
  });

  it('does not cache failures', async () => {
    const c = new TtlCache<number>();
    await expect(c.getOrLoad('k', 1000, async () => { throw new Error('x'); })).rejects.toThrow();
    expect(await c.getOrLoad('k', 1000, async () => 7)).toBe(7);
  });
});
