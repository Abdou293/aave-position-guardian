import { beforeEach, describe, expect, it } from 'vitest';
import { OnChainDataSource } from '../src/datasources/onchain.js';
import { FakeAaveCaller, MARKET, USERS } from './fixtures/fakeAaveMarket.js';

let now: number;
let fake: FakeAaveCaller;
let source: OnChainDataSource;

const clock = () => now;
// Fake sleep: advances the fake clock instantly, so retries/rate limits don't slow the tests.
const sleep = async (ms: number) => {
  now += ms;
};

function makeSource(extra: Partial<ConstructorParameters<typeof OnChainDataSource>[0]> = {}) {
  return new OnChainDataSource({
    addresses: { arbitrum: MARKET },
    callers: { arbitrum: fake },
    now: clock,
    sleep,
    random: () => 0.5,
    ...extra,
  });
}

const target = (wallet: `0x${string}`) => ({ network: 'arbitrum' as const, wallet });

beforeEach(() => {
  now = 1_800_000_000_000;
  fake = new FakeAaveCaller(clock);
  source = makeSource();
});

describe('OnChainDataSource', () => {
  it('reads a single-collateral position and passes the on-chain health factor through unchanged', async () => {
    const [r] = await source.getPositions([target(USERS.single)]);
    expect(r!.status).toBe('ok');
    const s = r!.snapshot!;
    expect(s.totalCollateralUsd).toBeCloseTo(34_000, 6);
    expect(s.totalDebtUsd).toBeCloseTo(15_998.4, 6);
    expect(s.liquidationThreshold).toBe(0.83);
    expect(s.ltv).toBe(0.805);
    expect(s.healthFactor).toBe(1.7638); // exactly what the contract returned, not recomputed
    expect(s.healthFactorWad).toBe('1763800000000000000');
    expect(s.collateral).toEqual([expect.objectContaining({ symbol: 'WETH', amount: 10, valueUsd: 34_000 })]);
    expect(s.debts[0]).toMatchObject({ symbol: 'USDC', amount: 16_000 });
    expect(s.blockNumber).toBe(1000);
  });

  it('represents "no debt" as a null health factor', async () => {
    const [r] = await source.getPositions([target(USERS.noDebt)]);
    expect(r!.status).toBe('ok');
    expect(r!.snapshot!.healthFactor).toBeNull();
    expect(r!.snapshot!.totalDebtUsd).toBe(0);
    expect(r!.snapshot!.collateral.map((c) => c.symbol)).toEqual(['USDC']);
  });

  it('handles a wallet that never used Aave (no breakdown reads needed)', async () => {
    const [r] = await source.getPositions([target(USERS.empty)]);
    expect(r!.status).toBe('ok');
    expect(r!.snapshot!.healthFactor).toBeNull();
    expect(r!.snapshot!.collateral).toEqual([]);
    expect(fake.batches.some((b) => b.includes('getUserReserveData'))).toBe(false);
  });

  it('lists multiple collateral assets sorted by value and respects token decimals', async () => {
    const [r] = await source.getPositions([target(USERS.multi)]);
    const c = r!.snapshot!.collateral;
    expect(c.map((x) => x.symbol)).toEqual(['WETH', 'WBTC']);
    expect(c[0]!.valueUsd).toBeCloseTo(13_600, 6);
    expect(c[1]!.amount).toBeCloseTo(0.1, 12); // 8 decimals
    expect(c[1]!.valueUsd).toBeCloseTo(9_500, 6);
  });

  it('batches all wallets of a network into ONE multicall and caches static data and balances', async () => {
    const wallets = [USERS.single, USERS.multi, USERS.noDebt];
    await source.getPositions(wallets.map(target));
    const accountBatches = fake.batches.filter((b) => b.includes('getUserAccountData'));
    expect(accountBatches).toHaveLength(1);
    expect(accountBatches[0]!.filter((f) => f === 'getUserAccountData')).toHaveLength(3);
    // static: 2 multicalls, stage 1: 1, balances: 1 per wallet with a position (3)
    expect(fake.multicallCount).toBe(6);

    // Second read inside the cache window: only the stage-1 multicall is sent again.
    now += 30_000;
    await source.getPositions(wallets.map(target));
    expect(fake.multicallCount).toBe(7);
  });

  it('returns results in the same order as requested, removing duplicate wallets from the batch', async () => {
    const rs = await source.getPositions([target(USERS.multi), target(USERS.single), target(USERS.multi)]);
    expect(rs.map((r) => r.wallet)).toEqual([USERS.multi, USERS.single, USERS.multi]);
    const batch = fake.batches.find((b) => b.includes('getUserAccountData'))!;
    expect(batch.filter((f) => f === 'getUserAccountData')).toHaveLength(2);
  });

  it('retries a transient RPC failure and then succeeds', async () => {
    fake.failNextRequests = 2;
    const [r] = await source.getPositions([target(USERS.single)]);
    expect(r!.status).toBe('ok');
  });

  it('reports an error (never fake data) when the RPC is down and there is no previous reading', async () => {
    fake.failNextRequests = 100;
    const [r] = await source.getPositions([target(USERS.single)]);
    expect(r!.status).toBe('error');
    expect(r!.snapshot).toBeNull();
    const health = source.getNetworkHealth().find((h) => h.network === 'arbitrum')!;
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastSuccessAt).toBeNull();
  });

  it('never leaks an RPC API key in error messages', async () => {
    fake.failNextRequests = 100;
    const [r] = await source.getPositions([target(USERS.single)]);
    expect(r!.error).toBeDefined();
    expect(r!.error).not.toContain('FAKEKEY');
    expect(JSON.stringify(source.getNetworkHealth())).not.toContain('FAKEKEY');
  });

  it('serves the last good snapshot marked STALE when the RPC fails later', async () => {
    await source.getPositions([target(USERS.single)]);
    now += 120_000;
    fake.failNextRequests = 100;
    const [r] = await source.getPositions([target(USERS.single)]);
    expect(r!.status).toBe('stale');
    expect(r!.staleReason).toBe('rpc-error');
    expect(r!.ageMs).toBeGreaterThanOrEqual(120_000);
    expect(r!.snapshot!.healthFactor).toBe(1.7638);
  });

  it('marks data STALE when the RPC returns an old block (lagging node)', async () => {
    fake.blockTimestamp = () => BigInt(Math.floor(now / 1000) - 900); // 15 minutes behind
    const [r] = await source.getPositions([target(USERS.single)]);
    expect(r!.status).toBe('stale');
    expect(r!.staleReason).toBe('rpc-lagging');
  });

  it('isolates a failing wallet: the others still succeed', async () => {
    const [bad, good] = await source.getPositions([target(USERS.broken), target(USERS.single)]);
    expect(bad!.status).toBe('error');
    expect(bad!.error).toContain('getUserAccountData failed');
    expect(good!.status).toBe('ok');
  });

  it('keeps the on-chain aggregates when only the per-asset breakdown fails', async () => {
    fake.failPrices = true;
    const [r] = await source.getPositions([target(USERS.single)]);
    expect(r!.status).toBe('ok');
    expect(r!.snapshot!.healthFactor).toBe(1.7638);
    expect(r!.snapshot!.assetBreakdownAvailable).toBe(false);
    expect(r!.snapshot!.collateral).toEqual([]);
  });

  it('refuses networks whose addresses were not verified', async () => {
    const [r] = await source.getPositions([{ network: 'polygon', wallet: USERS.single }]);
    expect(r!.status).toBe('error');
    expect(r!.error).toMatch(/not verified/);
  });

  it('spaces RPC requests on the same network by the rate limit', async () => {
    const times: number[] = [];
    const original = fake.multicall.bind(fake);
    fake.multicall = async (calls) => {
      times.push(now);
      return original(calls);
    };
    source = makeSource({ minRequestIntervalMs: 1_000 });
    await source.getPositions([target(USERS.single)]);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1_000);
  });
});
