// WHAT-IF ESTIMATE: "about how far can the main collateral's price fall before HF reaches 1?"
//
// This is OUR OWN approximation, not an Aave number. It is always returned together with
// its formula and assumptions so the user can judge it. It is NOT a guarantee.
//
// Derivation (all inputs are on-chain values from the snapshot):
//   Aave:  HF = (TotalCollateral × LT_avg) / TotalDebt
//   Let X be the largest collateral asset, s = value(X) / TotalCollateral (its share).
//   If X's price falls by a fraction d, and everything else (other prices, debt, LT_avg) stays the same:
//          HF' ≈ HF × (1 − s × d)
//   Setting HF' = 1 gives:
//          d = (1 − 1/HF) / s
//
// Exact when X is the only collateral. Approximate when assets with different liquidation
// thresholds are mixed (LT_avg changes as the mix changes).
import type { PositionSnapshot } from '../core/types.js';

export const WHAT_IF_FORMULA = 'drop ≈ (1 − 1/HF) ÷ s, where s = main collateral value ÷ total collateral';

export const WHAT_IF_ASSUMPTIONS = [
  'Estimate only, not a guarantee. Liquidation can happen earlier.',
  'Assumes all other asset prices and the debt stay the same.',
  'Uses the position-wide average liquidation threshold (exact only with a single collateral asset).',
  'Ignores interest accrual, oracle delays and any protocol parameter changes.',
];

export type WhatIfEstimate =
  | { kind: 'no-debt'; message: string }
  | { kind: 'at-or-below-1'; healthFactor: number; message: string }
  | { kind: 'unavailable'; message: string }
  | {
      kind: 'not-reachable';
      asset: string;
      share: number;
      message: string;
      formula: string;
      assumptions: string[];
    }
  | {
      kind: 'estimate';
      asset: string;
      /** Fraction of the current price, e.g. 0.23 = a 23% drop. */
      dropFraction: number;
      currentPriceUsd: number;
      estimatedLiquidationPriceUsd: number;
      share: number;
      healthFactor: number;
      /** True if the same asset is also borrowed (its debt would shrink too, so the estimate is conservative). */
      assetAlsoBorrowed: boolean;
      message: string;
      formula: string;
      assumptions: string[];
    };

export function estimateLiquidationPriceDrop(s: PositionSnapshot): WhatIfEstimate {
  if (s.healthFactor === null || s.totalDebtUsd <= 0) {
    return { kind: 'no-debt', message: 'No debt: this position cannot be liquidated.' };
  }
  const hf = s.healthFactor;
  if (hf <= 1) {
    return { kind: 'at-or-below-1', healthFactor: hf, message: 'Health factor is at or below 1: the position can be liquidated now.' };
  }
  const main = s.collateral[0];
  if (!s.assetBreakdownAvailable || !main || s.totalCollateralUsd <= 0 || main.valueUsd <= 0 || main.priceUsd <= 0) {
    return { kind: 'unavailable', message: 'Per-asset data is unavailable, so no estimate can be made right now.' };
  }

  const share = Math.min(1, main.valueUsd / s.totalCollateralUsd);
  const drop = (1 - 1 / hf) / share;
  const assumptions = [...WHAT_IF_ASSUMPTIONS];

  if (drop >= 1) {
    return {
      kind: 'not-reachable',
      asset: main.symbol,
      share,
      message: `A fall in ${main.symbol} alone would not bring the health factor to 1, even if it went to zero (other prices unchanged).`,
      formula: WHAT_IF_FORMULA,
      assumptions,
    };
  }

  if (s.eModeCategory > 0) {
    assumptions.push(
      'This position uses E-Mode (correlated assets). If the borrowed asset moves together with the collateral, the real risk from this price move can be much lower than estimated.',
    );
  }
  const assetAlsoBorrowed = s.debts.some((d) => d.asset === main.asset);
  if (assetAlsoBorrowed) assumptions.push(`${main.symbol} is also borrowed; that debt would shrink too, so the real drop needed is larger.`);

  return {
    kind: 'estimate',
    asset: main.symbol,
    dropFraction: drop,
    currentPriceUsd: main.priceUsd,
    estimatedLiquidationPriceUsd: main.priceUsd * (1 - drop),
    share,
    healthFactor: hf,
    assetAlsoBorrowed,
    message: `Estimate: a fall of about ${(drop * 100).toFixed(1)}% in ${main.symbol} (to about $${(main.priceUsd * (1 - drop)).toFixed(2)}) would bring the health factor to about 1.`,
    formula: WHAT_IF_FORMULA,
    assumptions,
  };
}
