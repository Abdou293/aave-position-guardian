// Shared data types. Every data source (on-chain or simulated) speaks this language,
// so the alert engine, bot and dashboard never care where the data came from.
import type { Address } from 'viem';
import type { NetworkKey } from '../chain/networks.js';

/** One wallet on one network that the user wants to watch. */
export interface WatchTarget {
  network: NetworkKey;
  wallet: Address;
}

/** One asset inside a position (a collateral deposit or a debt). */
export interface AssetPosition {
  asset: Address;
  symbol: string;
  /** Token amount in whole units (e.g. 1.5 WETH). */
  amount: number;
  /** Value in USD (Aave V3 base currency on the supported markets). */
  valueUsd: number;
  /** Oracle price in USD for 1 whole token. */
  priceUsd: number;
}

/**
 * A position as Aave reports it. The aggregate numbers (collateral, debt, health factor,
 * liquidation threshold, LTV) come directly from Pool.getUserAccountData. They are NOT
 * recomputed here.
 */
export interface PositionSnapshot {
  network: NetworkKey;
  wallet: Address;
  source: 'onchain' | 'simulated';
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  /** Weighted average liquidation threshold, as a fraction (0.83 = 83%). */
  liquidationThreshold: number;
  /** Weighted average loan-to-value, as a fraction. */
  ltv: number;
  /** Health factor. `null` means "no debt" (Aave reports the max uint256 value). */
  healthFactor: number | null;
  /** Raw health factor as returned on-chain (1e18 = 1.0), kept for audit. */
  healthFactorWad: string;
  /** Aave efficiency-mode category (0 = none). */
  eModeCategory: number;
  collateral: AssetPosition[];
  debts: AssetPosition[];
  /** False when the per-asset breakdown could not be read (the aggregates are still valid). */
  assetBreakdownAvailable: boolean;
  blockNumber: number | null;
  /** Block timestamp in seconds (or simulated time). */
  blockTimestamp: number;
}

export type ReadStatus = 'ok' | 'stale' | 'error';
export type StaleReason = 'rpc-error' | 'rpc-lagging';

/** The result of reading one target. A failed read never pretends to be fresh. */
export interface PositionReadResult {
  network: NetworkKey;
  wallet: Address;
  /**
   * ok    = fresh data.
   * stale = data shown is old: the last good snapshot after an RPC error, or the RPC's block is too old.
   * error = nothing usable.
   */
  status: ReadStatus;
  snapshot: PositionSnapshot | null;
  /** When this read happened (ms since epoch). */
  fetchedAt: number;
  staleReason?: StaleReason;
  /** Age of the snapshot data in ms (for stale results). */
  ageMs?: number;
  error?: string;
}

export interface NetworkHealth {
  network: NetworkKey;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastBlockNumber: number | null;
}

/** Anything that can produce positions: the on-chain reader or the simulator. */
export interface PositionDataSource {
  readonly kind: 'onchain' | 'simulated';
  getPositions(targets: WatchTarget[]): Promise<PositionReadResult[]>;
  getNetworkHealth(): NetworkHealth[];
}
