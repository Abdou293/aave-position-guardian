// SIMULATED data source for demo mode: no wallet, RPC, API key or real money needed.
//
// Prices follow smooth, deterministic paths over time (same time => same numbers), and positions
// are computed the way Aave does it:
//   HF = Σ(collateral value × liquidation threshold) / total debt
// All addresses here are FAKE placeholders and clearly labelled as demo data.
import { getAddress, maxUint256, type Address } from 'viem';
import type { NetworkKey } from '../chain/networks.js';
import { NETWORK_KEYS } from '../chain/networks.js';
import type {
  AssetPosition,
  NetworkHealth,
  PositionDataSource,
  PositionReadResult,
  PositionSnapshot,
  WatchTarget,
} from '../core/types.js';
import { NetworkHealthTracker } from './networkHealth.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const TAU = 2 * Math.PI;

/** Fake, obviously-not-real addresses: 0xDE30... = demo wallet, 0xA55E... = demo asset. */
const demoAddr = (prefix: string, n: number) => getAddress(`0x${prefix}${n.toString(16).padStart(40 - prefix.length, '0')}`);

type PriceFn = (t: number) => number;

/** The liquidation drill: one cycle every 30 minutes. */
export const DRILL_CYCLE_MS = 30 * MIN;

/**
 * Price multiplier for the drill scenario, by position in the 30-minute cycle:
 *   0%–15%  calm (factor 1.0)
 *   15%–45% steady fall to 0.62 (the health factor crosses 1.5, 1.25 and 1.10)
 *   45%–55% hovering near the bottom
 *   55%–85% recovery back to 1.0
 *   85%–100% calm
 * A small fast ripple (±1.5%, 20 s period) makes the value oscillate around thresholds,
 * which is exactly what the alert engine's hysteresis must handle.
 */
export function drillFactor(t: number): number {
  const phase = (((t % DRILL_CYCLE_MS) + DRILL_CYCLE_MS) % DRILL_CYCLE_MS) / DRILL_CYCLE_MS;
  const bottom = 0.62;
  let base: number;
  if (phase < 0.15) base = 1;
  else if (phase < 0.45) base = 1 - (1 - bottom) * ((phase - 0.15) / 0.3);
  else if (phase < 0.55) base = bottom;
  else if (phase < 0.85) base = bottom + (1 - bottom) * ((phase - 0.55) / 0.3);
  else base = 1;
  const ripple = 0.015 * Math.sin((TAU * t) / 20_000);
  return base * (1 + ripple);
}

const PRICES = {
  ETH: (t: number) => 3400 * (1 + 0.02 * Math.sin((TAU * t) / (6 * HOUR))),
  BTC: (t: number) => 95_000 * (1 + 0.015 * Math.sin((TAU * t) / (8 * HOUR) + 1)),
  USD: () => 1,
  DRILL_ETH: (t: number) => 3400 * drillFactor(t),
} satisfies Record<string, PriceFn>;

interface SimAsset {
  symbol: string;
  asset: Address;
  amount: number;
  price: PriceFn;
  /** Liquidation threshold and LTV for collateral (fractions). */
  lt?: number;
  ltv?: number;
}

export interface DemoScenario {
  id: string;
  label: string;
  network: NetworkKey;
  wallet: Address;
  collateral: SimAsset[];
  debts: SimAsset[];
}

const A = {
  WETH: demoAddr('a55e', 1),
  USDC: demoAddr('a55e', 2),
  WBTC: demoAddr('a55e', 3),
};

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'liquidation-drill',
    label: 'Liquidation drill: falls toward HF 1.09 and recovers every 30 min',
    network: 'ethereum',
    wallet: demoAddr('de30', 1),
    collateral: [{ symbol: 'WETH', asset: A.WETH, amount: 10, price: PRICES.DRILL_ETH, lt: 0.83, ltv: 0.805 }],
    debts: [{ symbol: 'USDC', asset: A.USDC, amount: 16_000, price: PRICES.USD }],
  },
  {
    id: 'steady',
    label: 'Steady borrower: comfortable health factor',
    network: 'arbitrum',
    wallet: demoAddr('de30', 2),
    collateral: [{ symbol: 'WETH', asset: A.WETH, amount: 5, price: PRICES.ETH, lt: 0.83, ltv: 0.805 }],
    debts: [{ symbol: 'USDC', asset: A.USDC, amount: 6_000, price: PRICES.USD }],
  },
  {
    id: 'multi-collateral',
    label: 'Multiple collateral assets (WETH + WBTC)',
    network: 'base',
    wallet: demoAddr('de30', 3),
    collateral: [
      { symbol: 'WETH', asset: A.WETH, amount: 4, price: PRICES.ETH, lt: 0.83, ltv: 0.805 },
      { symbol: 'WBTC', asset: A.WBTC, amount: 0.1, price: PRICES.BTC, lt: 0.78, ltv: 0.73 },
    ],
    debts: [{ symbol: 'USDC', asset: A.USDC, amount: 12_000, price: PRICES.USD }],
  },
  {
    id: 'no-debt',
    label: 'Supplier only: no debt, cannot be liquidated',
    network: 'polygon',
    wallet: demoAddr('de30', 4),
    collateral: [
      { symbol: 'USDC', asset: A.USDC, amount: 2_000, price: PRICES.USD, lt: 0.78, ltv: 0.75 },
      { symbol: 'WETH', asset: A.WETH, amount: 1, price: PRICES.ETH, lt: 0.83, ltv: 0.805 },
    ],
    debts: [],
  },
];

/** Computes a snapshot for one scenario at time t (ms), with Aave's formulas. */
export function simulatePosition(sc: DemoScenario, t: number): PositionSnapshot {
  const toPos = (a: SimAsset): AssetPosition => {
    const priceUsd = a.price(t);
    return { asset: a.asset, symbol: a.symbol, amount: a.amount, priceUsd, valueUsd: a.amount * priceUsd };
  };
  const collateral = sc.collateral.map(toPos).sort((a, b) => b.valueUsd - a.valueUsd);
  const debts = sc.debts.map(toPos).sort((a, b) => b.valueUsd - a.valueUsd);

  const totalCollateralUsd = collateral.reduce((s, p) => s + p.valueUsd, 0);
  const totalDebtUsd = debts.reduce((s, p) => s + p.valueUsd, 0);
  const weighted = (key: 'lt' | 'ltv') =>
    sc.collateral.reduce((s, a) => s + a.amount * a.price(t) * (a[key] ?? 0), 0);
  const ltSum = weighted('lt');
  const ltvSum = weighted('ltv');
  const healthFactor = totalDebtUsd > 0 ? ltSum / totalDebtUsd : null;

  return {
    network: sc.network,
    wallet: sc.wallet,
    source: 'simulated',
    totalCollateralUsd,
    totalDebtUsd,
    availableBorrowsUsd: Math.max(0, ltvSum - totalDebtUsd),
    liquidationThreshold: totalCollateralUsd > 0 ? ltSum / totalCollateralUsd : 0,
    ltv: totalCollateralUsd > 0 ? ltvSum / totalCollateralUsd : 0,
    healthFactor,
    // Same encoding as Aave: 1e18 = 1.0, max uint256 when there is no debt.
    healthFactorWad: healthFactor === null ? maxUint256.toString() : (BigInt(Math.round(healthFactor * 1e9)) * 10n ** 9n).toString(),
    eModeCategory: 0,
    collateral,
    debts,
    assetBreakdownAvailable: true,
    blockNumber: Math.floor(t / 12_000),
    blockTimestamp: Math.floor(t / 1000),
  };
}

export interface SimulatedDataSourceOptions {
  now?: () => number;
  scenarios?: DemoScenario[];
}

export class SimulatedDataSource implements PositionDataSource {
  readonly kind = 'simulated' as const;
  private readonly now: () => number;
  private readonly scenarios: DemoScenario[];
  private readonly health = new NetworkHealthTracker(NETWORK_KEYS);
  /** Networks currently forced to fail, to demo the health page and stale handling. */
  readonly failingNetworks = new Set<NetworkKey>();
  private readonly lastGood = new Map<string, { snapshot: PositionSnapshot; at: number }>();

  constructor(opts: SimulatedDataSourceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.scenarios = opts.scenarios ?? DEMO_SCENARIOS;
  }

  getNetworkHealth(): NetworkHealth[] {
    return this.health.snapshot();
  }

  async getPositions(targets: WatchTarget[]): Promise<PositionReadResult[]> {
    const t = this.now();
    const touched = new Set<NetworkKey>();
    const results = targets.map((target): PositionReadResult => {
      const key = `${target.network}:${target.wallet}`;
      touched.add(target.network);
      if (this.failingNetworks.has(target.network)) {
        const error = 'Simulated RPC outage';
        const last = this.lastGood.get(key);
        return last
          ? { ...target, status: 'stale', staleReason: 'rpc-error', snapshot: last.snapshot, fetchedAt: t, ageMs: t - last.at, error }
          : { ...target, status: 'error', snapshot: null, fetchedAt: t, error };
      }
      const sc = this.scenarios.find((s) => s.network === target.network && s.wallet === target.wallet);
      if (!sc) {
        return { ...target, status: 'error', snapshot: null, fetchedAt: t, error: 'Not a demo wallet. Demo mode only serves the sample wallets.' };
      }
      const snapshot = simulatePosition(sc, t);
      this.lastGood.set(key, { snapshot, at: t });
      return { ...target, status: 'ok', snapshot, fetchedAt: t };
    });
    for (const network of touched) {
      if (this.failingNetworks.has(network)) this.health.recordFailure(network, t, 'Simulated RPC outage');
      else this.health.recordSuccess(network, t, Math.floor(t / 12_000));
    }
    return results;
  }
}
