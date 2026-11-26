import { describe, expect, it } from 'vitest';
import {
  DEMO_SCENARIOS,
  DRILL_CYCLE_MS,
  SimulatedDataSource,
  simulatePosition,
} from '../src/datasources/simulated.js';

const drill = DEMO_SCENARIOS.find((s) => s.id === 'liquidation-drill')!;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % DRILL_CYCLE_MS); // start of a cycle

function hfSeries(stepMs = 5_000) {
  const out: number[] = [];
  for (let t = T0; t < T0 + DRILL_CYCLE_MS; t += stepMs) out.push(simulatePosition(drill, t).healthFactor!);
  return out;
}

describe('simulated data source', () => {
  it('is deterministic: the same time gives the same numbers', () => {
    expect(simulatePosition(drill, T0 + 123_456)).toEqual(simulatePosition(drill, T0 + 123_456));
  });

  it('computes HF with Aave\'s formula: Σ(collateral × LT) / debt', () => {
    const s = simulatePosition(drill, T0);
    const expected = (s.collateral[0]!.valueUsd * 0.83) / s.totalDebtUsd;
    expect(s.healthFactor).toBeCloseTo(expected, 12);
    expect(s.liquidationThreshold).toBeCloseTo(0.83, 12);
  });

  it('liquidation drill: falls below 1.25 and 1.10, never reaches 1, and recovers above 1.5', () => {
    const hf = hfSeries();
    expect(hf[0]).toBeGreaterThan(1.5);
    expect(Math.min(...hf)).toBeLessThan(1.1);
    expect(Math.min(...hf)).toBeGreaterThan(1.0);
    expect(hf.at(-1)).toBeGreaterThan(1.5);
  });

  it('liquidation drill: oscillates around thresholds (crosses 1.25 more than twice in one cycle)', () => {
    const hf = hfSeries(1_000);
    let crossings = 0;
    for (let i = 1; i < hf.length; i++) if ((hf[i - 1]! - 1.25) * (hf[i]! - 1.25) < 0) crossings++;
    expect(crossings).toBeGreaterThan(2);
  });

  it('no-debt scenario has a null health factor', () => {
    const s = simulatePosition(DEMO_SCENARIOS.find((x) => x.id === 'no-debt')!, T0);
    expect(s.healthFactor).toBeNull();
    expect(s.totalDebtUsd).toBe(0);
  });

  it('multi-collateral scenario uses a value-weighted liquidation threshold', () => {
    const s = simulatePosition(DEMO_SCENARIOS.find((x) => x.id === 'multi-collateral')!, T0);
    expect(s.collateral).toHaveLength(2);
    const [a, b] = s.collateral;
    const weighted = (a!.valueUsd * (a!.symbol === 'WETH' ? 0.83 : 0.78) + b!.valueUsd * (b!.symbol === 'WETH' ? 0.83 : 0.78)) / s.totalCollateralUsd;
    expect(s.liquidationThreshold).toBeCloseTo(weighted, 12);
  });

  it('returns an error for a wallet that is not a demo wallet', async () => {
    const src = new SimulatedDataSource({ now: () => T0 });
    const [r] = await src.getPositions([{ network: 'ethereum', wallet: '0x0000000000000000000000000000000000000001' }]);
    expect(r!.status).toBe('error');
  });

  it('simulated outage: serves stale last-good data and records the failure', async () => {
    let now = T0;
    const src = new SimulatedDataSource({ now: () => now });
    const t = { network: drill.network, wallet: drill.wallet };
    await src.getPositions([t]);
    src.failingNetworks.add('ethereum');
    now += 60_000;
    const [r] = await src.getPositions([t]);
    expect(r!.status).toBe('stale');
    expect(r!.ageMs).toBe(60_000);
    expect(src.getNetworkHealth().find((h) => h.network === 'ethereum')!.consecutiveFailures).toBe(1);
  });
});
