// A fake Aave V3 market for offline tests. It answers the same view functions as the real
// contracts, with raw values in the same on-chain units (base currency 1e8, HF in 1e18, bps).
import { getAddress, maxUint256, type Address } from 'viem';
import type { MarketAddresses } from '../../src/chain/addresses.js';
import type { CallResult, ChainCaller, ContractCall } from '../../src/chain/caller.js';

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);

export const MARKET: MarketAddresses = {
  chainId: 42161,
  pool: addr(0x1001),
  poolAddressesProvider: addr(0x1002),
  oracle: addr(0x1003),
  poolDataProvider: addr(0x1004),
  uiPoolDataProvider: addr(0x1005),
  multicall3: addr(0x1006),
};

export const TOKENS = {
  WETH: { asset: addr(0x2001), symbol: 'WETH', decimals: 18n, price: 3_400n * 10n ** 8n },
  USDC: { asset: addr(0x2002), symbol: 'USDC', decimals: 6n, price: 99_990_000n }, // $0.9999
  WBTC: { asset: addr(0x2003), symbol: 'WBTC', decimals: 8n, price: 95_000n * 10n ** 8n },
};
const TOKEN_LIST = Object.values(TOKENS);

export const USERS = {
  /** 10 WETH collateral, 16,000 USDC debt. */
  single: addr(0x3001),
  /** 4 WETH + 0.1 WBTC collateral, 12,000 USDC debt. */
  multi: addr(0x3002),
  /** 2,000 USDC supplied, no debt. */
  noDebt: addr(0x3003),
  /** getUserAccountData reverts for this one. */
  broken: addr(0x3004),
  /** Never used Aave. */
  empty: addr(0x3005),
};

type Balances = Partial<Record<keyof typeof TOKENS, { supplied?: bigint; debt?: bigint; collateral?: boolean }>>;

interface FakeUser {
  /** [collateralBase, debtBase, availableBase, liqThresholdBps, ltvBps, hfWad] */
  account: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  eMode?: bigint;
  balances: Balances;
}

const e8 = (usd: number) => BigInt(Math.round(usd * 1e8));

export const FAKE_USERS: Record<string, FakeUser> = {
  [USERS.single]: {
    // HF deliberately given as Aave would return it; the reader must pass it through unchanged.
    account: [e8(34_000), e8(15_998.4), e8(11_371.6), 8300n, 8050n, 1_763_800_000_000_000_000n],
    balances: { WETH: { supplied: 10n * 10n ** 18n, collateral: true }, USDC: { debt: 16_000n * 10n ** 6n } },
  },
  [USERS.multi]: {
    account: [e8(23_100), e8(11_998.8), e8(4_871.5), 8131n, 7750n, 1_565_400_000_000_000_000n],
    balances: {
      WETH: { supplied: 4n * 10n ** 18n, collateral: true },
      WBTC: { supplied: 10_000_000n, collateral: true }, // 0.1 WBTC (8 decimals)
      USDC: { debt: 12_000n * 10n ** 6n },
    },
  },
  [USERS.noDebt]: {
    account: [e8(1_999.8), 0n, e8(1_499.85), 7800n, 7500n, maxUint256],
    balances: { USDC: { supplied: 2_000n * 10n ** 6n, collateral: true } },
  },
  [USERS.empty]: {
    account: [0n, 0n, 0n, 0n, 0n, maxUint256],
    balances: {},
  },
};

export class FakeAaveCaller implements ChainCaller {
  multicallCount = 0;
  blockNumberCount = 0;
  /** Calls inside each multicall, for batching assertions. */
  readonly batches: string[][] = [];
  /** Next N transport requests throw (like an RPC that is down). */
  failNextRequests = 0;
  failPrices = false;
  blockNumber = 1_000n;
  /** Block timestamp in seconds. Defaults to "now" via the clock. */
  blockTimestamp: () => bigint;

  constructor(clock: () => number) {
    this.blockTimestamp = () => BigInt(Math.floor(clock() / 1000));
  }

  private maybeFail() {
    if (this.failNextRequests > 0) {
      this.failNextRequests--;
      // Includes an RPC URL with a FAKE key: the reader must never leak it in error messages.
      // The key below is not real; the inline marker exempts only this exact line from secret scanning.
      throw new Error('HTTP request failed. URL: https://arb-mainnet.g.alchemy.com/v2/FAKEKEYabcdefghij1234567890\nDetails: fetch failed'); // gitleaks:allow
    }
  }

  async getBlockNumber() {
    this.blockNumberCount++;
    this.maybeFail();
    return this.blockNumber;
  }

  async multicall(calls: ContractCall[]): Promise<CallResult[]> {
    this.multicallCount++;
    this.maybeFail();
    this.batches.push(calls.map((c) => c.functionName));
    return calls.map((c) => {
      try {
        return { status: 'success', result: this.answer(c) };
      } catch (error) {
        return { status: 'failure', error: error as Error };
      }
    });
  }

  private answer(c: ContractCall): unknown {
    const args = (c.args ?? []) as unknown[];
    switch (c.functionName) {
      case 'getAllReservesTokens':
        return TOKEN_LIST.map((t) => ({ symbol: t.symbol, tokenAddress: t.asset }));
      case 'BASE_CURRENCY_UNIT':
        return 100_000_000n;
      case 'getReserveConfigurationData': {
        const t = TOKEN_LIST.find((x) => x.asset === args[0]);
        if (!t) throw new Error('unknown reserve');
        return [t.decimals, 8000n, 8300n, 10500n, 1000n, true, true, false, true, false];
      }
      case 'getCurrentBlockTimestamp':
        return this.blockTimestamp();
      case 'getAssetsPrices':
        if (this.failPrices) throw new Error('oracle reverted');
        return (args[0] as Address[]).map((a) => TOKEN_LIST.find((t) => t.asset === a)!.price);
      case 'getUserAccountData': {
        const u = FAKE_USERS[args[0] as string];
        if (!u) throw new Error('execution reverted');
        return u.account;
      }
      case 'getUserEMode':
        return FAKE_USERS[args[0] as string]?.eMode ?? 0n;
      case 'getUserReserveData': {
        const [asset, user] = args as [Address, Address];
        const sym = TOKEN_LIST.find((t) => t.asset === asset)!.symbol as keyof typeof TOKENS;
        const b = FAKE_USERS[user]?.balances[sym] ?? {};
        return [b.supplied ?? 0n, 0n, b.debt ?? 0n, 0n, 0n, 0n, 0n, 0, b.collateral ?? false];
      }
      default:
        throw new Error(`FakeAaveCaller: unexpected call ${c.functionName}`);
    }
  }
}
