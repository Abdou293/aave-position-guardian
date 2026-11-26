// On-chain data source: reads Aave V3 positions with read-only calls batched through Multicall3.
//
// RPC budget per network per cycle (N wallets, R reserves):
//   - 1 multicall: block number + timestamp + all oracle prices + account data for ALL N wallets
//   - per wallet with a position: 1 multicall of R balance reads, CACHED (default 5 min)
//   - static data (reserve list, symbols, decimals, base unit): cached (default 1 h)
// Every request goes through a per-network rate limiter and is retried with backoff.
import { formatUnits, type Address } from 'viem';
import { dataProviderAbi, multicall3Abi, oracleAbi, poolAbi } from '../chain/abis.js';
import type { MarketAddresses, VerifiedAddresses } from '../chain/addresses.js';
import type { CallResult, ChainCaller, ContractCall } from '../chain/caller.js';
import { NETWORK_KEYS, redactRpcUrl, type NetworkKey } from '../chain/networks.js';
import type {
  AssetPosition,
  NetworkHealth,
  PositionDataSource,
  PositionReadResult,
  PositionSnapshot,
  WatchTarget,
} from '../core/types.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { withRetry } from '../lib/retry.js';
import { TtlCache } from '../lib/ttlCache.js';
import { NetworkHealthTracker } from './networkHealth.js';

export interface OnChainDataSourceOptions {
  addresses: VerifiedAddresses;
  /** One caller per network (real: createViemCaller, tests: a fake). */
  callers: Partial<Record<NetworkKey, ChainCaller>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Minimum gap between two RPC requests on the same network. */
  minRequestIntervalMs?: number;
  retries?: number;
  staticTtlMs?: number;
  balancesTtlMs?: number;
  /** If the RPC's latest block is older than this, results are marked stale. */
  maxBlockAgeSec?: number;
}

interface ReserveInfo {
  asset: Address;
  symbol: string;
  decimals: number;
}

interface StaticData {
  reserves: ReserveInfo[];
  baseUnit: bigint;
}

interface UserBalance {
  asset: Address;
  supplied: bigint;
  debt: bigint;
  collateralEnabled: boolean;
}

type AccountData = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

/** Short, safe error text: first line only, RPC URLs (which may contain API keys) redacted. */
export function sanitizeError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  const text = (e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0] ?? 'unknown error';
  return text.replace(/https?:\/\/[^\s"')]+/g, (url) => redactRpcUrl(url)).slice(0, 300);
}

function ok<T>(r: CallResult | undefined, what: string): T {
  if (!r || r.status !== 'success') throw new Error(`${what} failed${r?.status === 'failure' ? `: ${sanitizeError(r.error)}` : ''}`);
  return r.result as T;
}

export class OnChainDataSource implements PositionDataSource {
  readonly kind = 'onchain' as const;
  private readonly now: () => number;
  private readonly limiters = new Map<NetworkKey, RateLimiter>();
  private readonly staticCache: TtlCache<StaticData>;
  private readonly balanceCache: TtlCache<UserBalance[]>;
  private readonly lastGood = new Map<string, { snapshot: PositionSnapshot; at: number }>();
  private readonly health = new NetworkHealthTracker(NETWORK_KEYS);

  constructor(private readonly opts: OnChainDataSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.staticCache = new TtlCache(this.now);
    this.balanceCache = new TtlCache(this.now);
  }

  getNetworkHealth(): NetworkHealth[] {
    return this.health.snapshot();
  }

  async getPositions(targets: WatchTarget[]): Promise<PositionReadResult[]> {
    const byNetwork = new Map<NetworkKey, Address[]>();
    for (const t of targets) {
      const list = byNetwork.get(t.network) ?? [];
      if (!list.includes(t.wallet)) list.push(t.wallet);
      byNetwork.set(t.network, list);
    }
    const perNetwork = await Promise.all(
      [...byNetwork].map(async ([network, wallets]) => this.readNetwork(network, wallets)),
    );
    const index = new Map<string, PositionReadResult>();
    for (const results of perNetwork) for (const r of results) index.set(`${r.network}:${r.wallet}`, r);
    return targets.map((t) => index.get(`${t.network}:${t.wallet}`)!);
  }

  // ---------------------------------------------------------------------------

  private async readNetwork(network: NetworkKey, wallets: Address[]): Promise<PositionReadResult[]> {
    const market = this.opts.addresses[network];
    const caller = this.opts.callers[network];
    const fetchedAt = this.now();
    if (!market || !caller) {
      const error = `Network "${network}" is not configured or its addresses are not verified.`;
      return wallets.map((wallet) => ({ network, wallet, status: 'error', snapshot: null, fetchedAt, error }));
    }

    try {
      const stat = await this.getStatic(network, market, caller);
      const assets = stat.reserves.map((r) => r.asset);

      // Stage 1: everything that changes every block, in ONE multicall.
      const blockNumber = Number(await this.limited(network, () => caller.getBlockNumber()));
      const stage1: ContractCall[] = [
        { address: market.multicall3, abi: multicall3Abi, functionName: 'getCurrentBlockTimestamp' },
        { address: market.oracle, abi: oracleAbi, functionName: 'getAssetsPrices', args: [assets] },
        ...wallets.flatMap((w): ContractCall[] => [
          { address: market.pool, abi: poolAbi, functionName: 'getUserAccountData', args: [w] },
          { address: market.pool, abi: poolAbi, functionName: 'getUserEMode', args: [w] },
        ]),
      ];
      const res = await this.call(network, caller, stage1);
      const blockTimestamp = Number(ok<bigint>(res[0], 'getCurrentBlockTimestamp'));
      const prices = res[1]?.status === 'success' ? (res[1].result as readonly bigint[]) : null;
      this.health.recordSuccess(network, fetchedAt, blockNumber);

      const blockAgeSec = fetchedAt / 1000 - blockTimestamp;
      const lagging = blockAgeSec > (this.opts.maxBlockAgeSec ?? 300);

      return await Promise.all(
        wallets.map(async (wallet, i): Promise<PositionReadResult> => {
          const acct = res[2 + i * 2];
          const emode = res[3 + i * 2];
          if (!acct || acct.status !== 'success') {
            return this.fallback(network, wallet, fetchedAt, `getUserAccountData failed: ${acct?.status === 'failure' ? sanitizeError(acct.error) : 'missing result'}`);
          }
          const snapshot = await this.buildSnapshot({
            network, market, caller, stat, prices, wallet, blockNumber, blockTimestamp,
            account: acct.result as AccountData,
            eModeCategory: emode?.status === 'success' ? Number(emode.result as bigint) : 0,
          });
          if (lagging) {
            return {
              network, wallet, status: 'stale', staleReason: 'rpc-lagging', snapshot, fetchedAt,
              ageMs: Math.round(blockAgeSec * 1000),
              error: `RPC latest block is ${Math.round(blockAgeSec)}s old.`,
            };
          }
          this.lastGood.set(`${network}:${wallet}`, { snapshot, at: fetchedAt });
          return { network, wallet, status: 'ok', snapshot, fetchedAt };
        }),
      );
    } catch (err) {
      const error = sanitizeError(err);
      this.health.recordFailure(network, fetchedAt, error);
      return wallets.map((wallet) => this.fallback(network, wallet, fetchedAt, error));
    }
  }

  /** After a failure: serve the last good snapshot marked as stale, or an error if there is none. */
  private fallback(network: NetworkKey, wallet: Address, fetchedAt: number, error: string): PositionReadResult {
    const last = this.lastGood.get(`${network}:${wallet}`);
    if (last) {
      return {
        network, wallet, status: 'stale', staleReason: 'rpc-error', snapshot: last.snapshot,
        fetchedAt, ageMs: fetchedAt - last.at, error,
      };
    }
    return { network, wallet, status: 'error', snapshot: null, fetchedAt, error };
  }

  private async buildSnapshot(p: {
    network: NetworkKey;
    market: MarketAddresses;
    caller: ChainCaller;
    stat: StaticData;
    prices: readonly bigint[] | null;
    wallet: Address;
    account: AccountData;
    eModeCategory: number;
    blockNumber: number;
    blockTimestamp: number;
  }): Promise<PositionSnapshot> {
    const [collateralBase, debtBase, availableBase, liqThresholdBps, ltvBps, hfWad] = p.account;
    const usd = (v: bigint) => Number(formatUnits(v, decimalsOf(p.stat.baseUnit)));

    // Per-asset breakdown (needed for the what-if estimate). Optional: aggregates stay valid without it.
    let collateral: AssetPosition[] = [];
    let debts: AssetPosition[] = [];
    let assetBreakdownAvailable = false;
    const hasPosition = collateralBase > 0n || debtBase > 0n;
    if (!hasPosition) {
      assetBreakdownAvailable = true; // nothing to break down
    } else if (p.prices) {
      try {
        const balances = await this.getBalances(p.network, p.market, p.caller, p.stat, p.wallet);
        for (const [i, r] of p.stat.reserves.entries()) {
          const b = balances[i];
          const price = p.prices[i];
          if (!b || price === undefined) continue;
          const priceUsd = usd(price);
          const toPos = (raw: bigint): AssetPosition => {
            const amount = Number(formatUnits(raw, r.decimals));
            return { asset: r.asset, symbol: r.symbol, amount, priceUsd, valueUsd: amount * priceUsd };
          };
          if (b.supplied > 0n && b.collateralEnabled) collateral.push(toPos(b.supplied));
          if (b.debt > 0n) debts.push(toPos(b.debt));
        }
        collateral.sort((a, b) => b.valueUsd - a.valueUsd);
        debts.sort((a, b) => b.valueUsd - a.valueUsd);
        assetBreakdownAvailable = true;
      } catch {
        collateral = [];
        debts = [];
      }
    }

    return {
      network: p.network,
      wallet: p.wallet,
      source: 'onchain',
      totalCollateralUsd: usd(collateralBase),
      totalDebtUsd: usd(debtBase),
      availableBorrowsUsd: usd(availableBase),
      liquidationThreshold: Number(liqThresholdBps) / 10_000,
      ltv: Number(ltvBps) / 10_000,
      // With zero debt Aave returns type(uint256).max; we represent that as null ("no debt").
      healthFactor: debtBase === 0n ? null : Number(formatUnits(hfWad, 18)),
      healthFactorWad: hfWad.toString(),
      eModeCategory: p.eModeCategory,
      collateral,
      debts,
      assetBreakdownAvailable,
      blockNumber: p.blockNumber,
      blockTimestamp: p.blockTimestamp,
    };
  }

  private getStatic(network: NetworkKey, market: MarketAddresses, caller: ChainCaller): Promise<StaticData> {
    return this.staticCache.getOrLoad(network, this.opts.staticTtlMs ?? 60 * 60_000, async () => {
      const [tokensRes, unitRes] = await this.call(network, caller, [
        { address: market.poolDataProvider, abi: dataProviderAbi, functionName: 'getAllReservesTokens' },
        { address: market.oracle, abi: oracleAbi, functionName: 'BASE_CURRENCY_UNIT' },
      ]);
      const tokens = ok<readonly { symbol: string; tokenAddress: Address }[]>(tokensRes, 'getAllReservesTokens');
      const baseUnit = ok<bigint>(unitRes, 'BASE_CURRENCY_UNIT');
      const configs = await this.call(
        network,
        caller,
        tokens.map((t) => ({
          address: market.poolDataProvider,
          abi: dataProviderAbi,
          functionName: 'getReserveConfigurationData',
          args: [t.tokenAddress],
        })),
      );
      const reserves = tokens.map((t, i) => ({
        asset: t.tokenAddress,
        symbol: t.symbol,
        decimals: Number(ok<readonly [bigint, ...unknown[]]>(configs[i], `config ${t.symbol}`)[0]),
      }));
      return { reserves, baseUnit };
    });
  }

  private getBalances(
    network: NetworkKey,
    market: MarketAddresses,
    caller: ChainCaller,
    stat: StaticData,
    wallet: Address,
  ): Promise<UserBalance[]> {
    return this.balanceCache.getOrLoad(`${network}:${wallet}`, this.opts.balancesTtlMs ?? 5 * 60_000, async () => {
      const res = await this.call(
        network,
        caller,
        stat.reserves.map((r) => ({
          address: market.poolDataProvider,
          abi: dataProviderAbi,
          functionName: 'getUserReserveData',
          args: [r.asset, wallet],
        })),
      );
      return stat.reserves.map((r, i) => {
        const d = ok<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean]>(res[i], `reserve ${r.symbol}`);
        return { asset: r.asset, supplied: d[0], debt: d[1] + d[2], collateralEnabled: d[8] };
      });
    });
  }

  /** Rate-limited, retried multicall. */
  private call(network: NetworkKey, caller: ChainCaller, calls: ContractCall[]): Promise<CallResult[]> {
    return this.limited(network, () => caller.multicall(calls));
  }

  /** Runs one RPC request through the network's rate limiter, with retries and backoff. */
  private limited<T>(network: NetworkKey, request: () => Promise<T>): Promise<T> {
    let limiter = this.limiters.get(network);
    if (!limiter) {
      limiter = new RateLimiter({ minIntervalMs: this.opts.minRequestIntervalMs ?? 250, now: this.now, sleep: this.opts.sleep });
      this.limiters.set(network, limiter);
    }
    const l = limiter;
    return withRetry(() => l.schedule(request), {
      retries: this.opts.retries ?? 2,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
      sleep: this.opts.sleep,
      random: this.opts.random,
    });
  }
}

/** 100000000n -> 8. The base currency unit is always a power of ten. */
function decimalsOf(unit: bigint): number {
  const s = unit.toString();
  if (!/^10*$/.test(s)) throw new Error(`Unexpected BASE_CURRENCY_UNIT ${s}`);
  return s.length - 1;
}
