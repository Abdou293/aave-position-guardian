// Offline replay of REAL Aave V3 data recorded from local mainnet forks (scripts/fork-validate.ts).
// No network: every contract call is answered from the recording; an unrecorded call fails the test.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluate, initialAlertState } from '../src/alerts/engine.js';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/settings.js';
import { OnChainDataSource } from '../src/datasources/onchain.js';
import { estimateLiquidationPriceDrop } from '../src/risk/whatIf.js';
import { ReplayCaller, type ForkFixture } from './fixtures/forkFixture.js';

const DIR = join(import.meta.dirname, 'fixtures', 'fork');
const fixtures: ForkFixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as ForkFixture);

describe('fork fixtures exist for Ethereum and Arbitrum', () => {
  it('has recorded fixtures', () => {
    expect(fixtures.map((f) => f.network).sort()).toEqual(['arbitrum', 'ethereum']);
  });
});

describe.each(fixtures.map((f) => [`${f.network} @ block ${f.forkBlock}`, f] as const))('replay %s', (_name, fx) => {
  const read = async () => {
    const caller = new ReplayCaller(fx);
    const source = new OnChainDataSource({
      addresses: { [fx.network]: fx.market },
      callers: { [fx.network]: caller },
      now: () => fx.recordedNow,
      minRequestIntervalMs: 0,
    });
    const results = await source.getPositions(fx.wallets.map((w) => ({ network: fx.network, wallet: w.wallet })));
    return { results, caller };
  };

  it('every validation check passed when the fixture was recorded', () => {
    expect(fx.checks.length).toBeGreaterThan(10);
    expect(fx.checks.filter((c) => !c.pass)).toEqual([]);
  });

  it('the reader reproduces the recorded positions exactly, without any unrecorded call', async () => {
    const { results, caller } = await read();
    expect(caller.missing).toEqual([]);
    expect(results.map((r) => ({ ...r, fetchedAt: 0 }))).toEqual(fx.expected);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('includes real borrowers with debt and at least one position without debt', async () => {
    const { results } = await read();
    expect(results.filter((r) => (r.snapshot?.totalDebtUsd ?? 0) > 0).length).toBeGreaterThanOrEqual(2);
    expect(results.some((r) => r.snapshot?.healthFactor === null)).toBe(true);
  });

  it('what-if: at our estimated price, Aave\'s own health factor (measured on the fork) was ≈ 1', async () => {
    const { results } = await read();
    expect(fx.whatIfChecks.length).toBeGreaterThanOrEqual(1);
    for (const w of fx.whatIfChecks) {
      const snap = results.find((r) => r.wallet === w.wallet)!.snapshot!;
      const est = estimateLiquidationPriceDrop(snap);
      expect(est.kind).toBe('estimate');
      if (est.kind !== 'estimate') continue;
      expect(est.estimatedLiquidationPriceUsd).toBeCloseTo(w.estimatedLiquidationPriceUsd, 6);
      const tolerance = w.share > 0.999 ? 0.01 : 0.1;
      expect(Math.abs(w.aaveHealthFactorAtThatPrice - 1)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('the alert engine handles real readings (no crash, levels match the real health factor)', async () => {
    const { results } = await read();
    for (const r of results) {
      const out = evaluate(initialAlertState(), r, DEFAULT_ALERT_SETTINGS, fx.recordedNow);
      const hf = r.snapshot?.healthFactor ?? null;
      const expectAlert = hf !== null && hf < DEFAULT_ALERT_SETTINGS.thresholds[0]!;
      expect(out.events.some((e) => e.kind === 'threshold-crossed')).toBe(expectAlert);
    }
  });
});
