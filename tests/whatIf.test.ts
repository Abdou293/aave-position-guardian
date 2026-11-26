import { describe, expect, it } from 'vitest';
import type { PositionSnapshot } from '../src/core/types.js';
import { DEMO_SCENARIOS, simulatePosition, type DemoScenario } from '../src/datasources/simulated.js';
import { estimateLiquidationPriceDrop } from '../src/risk/whatIf.js';

const T = 1_800_000_000_000;

/** Re-runs a scenario with the main collateral price multiplied by `factor`. */
function withMainPriceFactor(sc: DemoScenario, factor: number, t = T): PositionSnapshot {
  const main = simulatePosition(sc, t).collateral[0]!.symbol;
  const changed: DemoScenario = {
    ...sc,
    collateral: sc.collateral.map((c) => (c.symbol === main ? { ...c, price: (x: number) => c.price(x) * factor } : c)),
  };
  return simulatePosition(changed, t);
}

describe('what-if estimate', () => {
  it('is exact for a single collateral asset: applying the estimated drop gives HF = 1', () => {
    const sc = DEMO_SCENARIOS.find((s) => s.id === 'steady')!;
    const e = estimateLiquidationPriceDrop(simulatePosition(sc, T));
    expect(e.kind).toBe('estimate');
    if (e.kind !== 'estimate') return;
    expect(withMainPriceFactor(sc, 1 - e.dropFraction).healthFactor).toBeCloseTo(1, 9);
  });

  it('is an approximation with mixed collateral, and stays close (within 0.03 of HF 1)', () => {
    const sc = DEMO_SCENARIOS.find((s) => s.id === 'multi-collateral')!;
    const e = estimateLiquidationPriceDrop(simulatePosition(sc, T));
    expect(e.kind).toBe('estimate');
    if (e.kind !== 'estimate') return;
    expect(e.share).toBeLessThan(1);
    const hfAfter = withMainPriceFactor(sc, 1 - e.dropFraction).healthFactor!;
    expect(Math.abs(hfAfter - 1)).toBeLessThan(0.03);
    expect(e.assumptions.join(' ')).toMatch(/average liquidation threshold/);
  });

  it('always ships the formula and an "estimate, not a guarantee" warning', () => {
    const e = estimateLiquidationPriceDrop(simulatePosition(DEMO_SCENARIOS[0]!, T));
    if (e.kind !== 'estimate') throw new Error('expected estimate');
    expect(e.formula).toContain('1/HF');
    expect(e.assumptions[0]).toMatch(/not a guarantee/);
  });

  it('no debt → cannot be liquidated', () => {
    const e = estimateLiquidationPriceDrop(simulatePosition(DEMO_SCENARIOS.find((s) => s.id === 'no-debt')!, T));
    expect(e.kind).toBe('no-debt');
  });

  const base: PositionSnapshot = simulatePosition(DEMO_SCENARIOS.find((s) => s.id === 'steady')!, T);

  it('HF at or below 1 → liquidatable now', () => {
    expect(estimateLiquidationPriceDrop({ ...base, healthFactor: 0.98 }).kind).toBe('at-or-below-1');
  });

  it('missing per-asset data → no estimate (never a guess)', () => {
    expect(estimateLiquidationPriceDrop({ ...base, assetBreakdownAvailable: false, collateral: [] }).kind).toBe('unavailable');
  });

  it('main collateral is a small share → a fall in it alone cannot liquidate', () => {
    const s: PositionSnapshot = {
      ...base,
      healthFactor: 3,
      collateral: [{ ...base.collateral[0]!, valueUsd: base.totalCollateralUsd * 0.4 }],
    };
    expect(estimateLiquidationPriceDrop(s).kind).toBe('not-reachable');
  });

  it('adds an E-Mode note and an "also borrowed" note when relevant', () => {
    const main = base.collateral[0]!;
    const e = estimateLiquidationPriceDrop({ ...base, eModeCategory: 1, debts: [{ ...main, amount: 0.5, valueUsd: main.priceUsd * 0.5 }] });
    if (e.kind !== 'estimate') throw new Error('expected estimate');
    expect(e.assetAlsoBorrowed).toBe(true);
    expect(e.assumptions.join(' ')).toMatch(/E-Mode/);
    expect(e.assumptions.join(' ')).toMatch(/also borrowed/);
  });
});
