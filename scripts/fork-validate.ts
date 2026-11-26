// FORK VALIDATION (read-only, local).
//
// For each network: start Anvil as a LOCAL fork of the real chain at a pinned block, then:
//   1. read positions of public wallets with OUR reader (talking ONLY to the local fork),
//   2. compare with a direct Pool.getUserAccountData call (must match exactly),
//   3. check that the per-asset breakdown adds up to Aave's totals,
//   4. what-if check: on the local fork only, set the main collateral price to OUR estimated
//      liquidation price and read Aave's own health factor (should be close to 1.0),
//   5. record every raw call result as a fixture for offline replay tests.
//
// Nothing is signed or sent to a real network. The price change in step 4 uses Anvil's
// `anvil_setCode` on the local copy only; the real chain is never touched.
//
//   npm run fork:validate                      (ethereum + arbitrum)
//   npm run fork:validate -- ethereum
// Needs Anvil (Foundry). Set ANVIL_PATH if it is not on PATH.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { AaveV3Arbitrum, AaveV3Ethereum } from '@bgd-labs/aave-address-book';
import {
  createPublicClient, getAddress, http, parseAbi, parseAbiItem, type Address, type PublicClient,
} from 'viem';
import { loadVerifiedAddresses, type MarketAddresses } from '../src/chain/addresses.js';
import { poolAbi } from '../src/chain/abis.js';
import type { CallResult, ChainCaller, ContractCall } from '../src/chain/caller.js';
import { NETWORKS, type NetworkKey } from '../src/chain/networks.js';
import type { PositionReadResult } from '../src/core/types.js';
import { OnChainDataSource } from '../src/datasources/onchain.js';
import { estimateLiquidationPriceDrop } from '../src/risk/whatIf.js';
import { encodeFixtureValue, type ForkFixture, type RecordedCall } from '../tests/fixtures/forkFixture.js';

const ANVIL = process.env.ANVIL_PATH ?? 'anvil';
const borrowEvent = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
);
const oracleSourceAbi = parseAbi(['function getSourceOfAsset(address asset) view returns (address)']);
const COLLECTOR: Partial<Record<NetworkKey, Address>> = {
  ethereum: AaveV3Ethereum.COLLECTOR as Address,
  arbitrum: AaveV3Arbitrum.COLLECTOR as Address,
};
const MAX_BORROWERS = 5;

// ------------------------------------------------------------------ fork-only caller with recording

function forkCaller(url: string, multicall3: Address, record: RecordedCall[], blocks: string[]): ChainCaller {
  // ONLY the local fork URL: no public fallback, so nothing can silently read the live chain.
  const client = createPublicClient({ transport: http(url, { timeout: 300_000, retryCount: 0 }) }) as PublicClient;
  return {
    async multicall(calls: ContractCall[]): Promise<CallResult[]> {
      const results = (await client.multicall({
        contracts: calls as never, allowFailure: true, multicallAddress: multicall3, batchSize: 16_384,
      })) as CallResult[];
      calls.forEach((c, i) => {
        const r = results[i]!;
        record.push({
          key: callKey(c),
          result: r.status === 'success' ? { status: 'success', value: encodeFixtureValue(r.result) } : { status: 'failure', error: 'call reverted' },
        });
      });
      return results;
    },
    async getBlockNumber() {
      const b = await client.getBlockNumber({ cacheTime: 0 });
      blocks.push(b.toString());
      return b;
    },
  };
}

export const callKey = (c: ContractCall) =>
  `${c.address.toLowerCase()}.${c.functionName}(${JSON.stringify(encodeFixtureValue(c.args ?? []))})`;

// ------------------------------------------------------------------ anvil

async function startAnvil(forkUrl: string, block: bigint, port: number): Promise<ChildProcess> {
  const child = spawn(ANVIL, ['--fork-url', forkUrl, '--fork-block-number', block.toString(), '--port', String(port), '--silent', '--no-rate-limit'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited: ${stderr.split('\n')[0]}`);
    const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' })
      .then((r) => r.ok).catch(() => false);
    if (ok) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('anvil did not start in 30 s');
}

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** EVM bytecode that returns `value` (32 bytes) for ANY call, e.g. latestAnswer(). */
function constantReturner(value: bigint): `0x${string}` {
  return `0x7f${value.toString(16).padStart(64, '0')}60005260206000f3`;
}

// ------------------------------------------------------------------ validation

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

async function validateNetwork(network: NetworkKey, market: MarketAddresses, port: number) {
  const net = NETWORKS[network];
  const upstreamUrl = net.publicRpcUrls[0]!;
  const upstream = createPublicClient({ chain: net.chain, transport: http(upstreamUrl, { timeout: 30_000 }) }) as PublicClient;
  const block = (await upstream.getBlockNumber()) - 5n;
  console.log(`\n=== ${network}: forking at block ${block} (upstream: public RPC) ===`);

  // Public wallets: recent borrowers (from public Borrow events up to the fork block) + well-known addresses.
  const borrowers: Address[] = [];
  for (const span of [2_000n, 10_000n, 50_000n]) {
    const logs = await upstream.getLogs({ address: market.pool, event: borrowEvent, fromBlock: block - span, toBlock: block }).catch(() => []);
    for (const l of logs.reverse()) {
      const a = l.args.onBehalfOf;
      if (a && !borrowers.includes(getAddress(a))) borrowers.push(getAddress(a));
      if (borrowers.length >= MAX_BORROWERS) break;
    }
    if (borrowers.length >= MAX_BORROWERS) break;
  }
  const wallets: Array<{ wallet: Address; why: string }> = [
    ...borrowers.map((wallet) => ({ wallet, why: 'borrower found in public Borrow events' })),
    ...(COLLECTOR[network] ? [{ wallet: getAddress(COLLECTOR[network]!), why: 'Aave Collector (treasury), from the official address book' }] : []),
    { wallet: getAddress(market.multicall3), why: 'Multicall3 contract (expected: no position)' },
  ];

  const anvil = await startAnvil(upstreamUrl, block, port);
  const forkUrl = `http://127.0.0.1:${port}`;
  try {
    const fork = createPublicClient({ transport: http(forkUrl, { timeout: 60_000 }) }) as PublicClient;
    const forkBlock = await fork.getBlockNumber();
    const forkTimestamp = Number((await fork.getBlock({ blockNumber: forkBlock })).timestamp);
    const record: RecordedCall[] = [];
    const blocks: string[] = [];
    const caller = forkCaller(forkUrl, market.multicall3, record, blocks);
    const now = forkTimestamp * 1000 + 10_000;
    const source = new OnChainDataSource({ addresses: { [network]: market }, callers: { [network]: caller }, now: () => now, minRequestIntervalMs: 0 });

    // Warm-up: a fresh fork pulls contract state from the upstream RPC on first access (slow on
    // Ethereum, which has many reserves). This first read is NOT checked or recorded.
    await new OnChainDataSource({
      addresses: { [network]: market }, callers: { [network]: forkCaller(forkUrl, market.multicall3, [], []) }, now: () => now, minRequestIntervalMs: 0,
    }).getPositions(wallets.map((w) => ({ network, wallet: w.wallet })));
    const results = await source.getPositions(wallets.map((w) => ({ network, wallet: w.wallet })));
    const checks: Check[] = [];
    const add = (name: string, pass: boolean, detail: string) => {
      checks.push({ name, pass, detail });
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
    };

    add('fork block', forkBlock === block, `fork=${forkBlock} pinned=${block}`);

    const whatIfChecks: ForkFixture['whatIfChecks'] = [];
    for (const [i, r] of results.entries()) {
      const w = wallets[i]!;
      const tag = `${w.wallet.slice(0, 10)}… (${w.why})`;
      const direct = (await fork.readContract({ address: market.pool, abi: poolAbi, functionName: 'getUserAccountData', args: [w.wallet] })) as readonly bigint[];
      if (r.status !== 'ok' || !r.snapshot) {
        add(`read ok: ${tag}`, false, `status=${r.status} error=${r.error ?? ''}`);
        continue;
      }
      const s = r.snapshot;
      add(`read ok: ${tag}`, true, `HF=${s.healthFactor?.toFixed(4) ?? 'no debt'} collateral=$${s.totalCollateralUsd.toFixed(2)} debt=$${s.totalDebtUsd.toFixed(2)}`);
      add(`HF matches Pool exactly: ${tag}`, s.healthFactorWad === direct[5]!.toString(), `ours=${s.healthFactorWad} pool=${direct[5]}`);
      add(
        `collateral/debt match Pool: ${tag}`,
        s.totalCollateralUsd === Number(direct[0]) / 1e8 && s.totalDebtUsd === Number(direct[1]) / 1e8,
        `collateral ${s.totalCollateralUsd} vs ${Number(direct[0]) / 1e8}, debt ${s.totalDebtUsd} vs ${Number(direct[1]) / 1e8}`,
      );

      if (s.assetBreakdownAvailable && s.totalCollateralUsd > 0) {
        const sumC = s.collateral.reduce((a, x) => a + x.valueUsd, 0);
        const sumD = s.debts.reduce((a, x) => a + x.valueUsd, 0);
        // Aave sums per-asset values in integer base units (1e-8 USD), we sum floats: allow 0.1% OR 1 cent
        // (dust positions of a few base units would otherwise fail on rounding alone).
        const dC = Math.abs(sumC - s.totalCollateralUsd);
        const dD = Math.abs(sumD - s.totalDebtUsd);
        const okC = dC <= 0.01 || dC / s.totalCollateralUsd <= 0.001;
        const okD = dD <= 0.01 || dD / Math.max(s.totalDebtUsd, 1e-18) <= 0.001;
        add(`breakdown adds up (≤0.1% or ≤$0.01): ${tag}`, okC && okD, `collateral diff ${dC.toFixed(8)}, debt diff ${dD.toFixed(8)}`);
      }

      // What-if: set the main collateral price to our estimated liquidation price (on the LOCAL fork only).
      const est = estimateLiquidationPriceDrop(s);
      if (est.kind === 'estimate' && !est.assetAlsoBorrowed) {
        const asset = s.collateral.reduce((a, b) => (b.valueUsd > a.valueUsd ? b : a));
        const src = (await fork.readContract({ address: market.oracle, abi: oracleSourceAbi, functionName: 'getSourceOfAsset', args: [asset.asset] })) as Address;
        const snapshotId = await rpc(forkUrl, 'evm_snapshot', []);
        const originalCode = await fork.getCode({ address: src });
        await rpc(forkUrl, 'anvil_setCode', [src, constantReturner(BigInt(Math.round(est.estimatedLiquidationPriceUsd * 1e8)))]);
        const after = (await fork.readContract({ address: market.pool, abi: poolAbi, functionName: 'getUserAccountData', args: [w.wallet] })) as readonly bigint[];
        await rpc(forkUrl, 'evm_revert', [snapshotId]);
        const restored = await fork.getCode({ address: src });
        const hfAfter = Number(after[5]!) / 1e18;
        const exactCase = est.share > 0.999;
        const tolerance = exactCase ? 0.01 : 0.1;
        whatIfChecks.push({
          wallet: w.wallet, asset: est.asset, share: est.share, dropFraction: est.dropFraction,
          estimatedLiquidationPriceUsd: est.estimatedLiquidationPriceUsd, aaveHealthFactorAtThatPrice: hfAfter,
        });
        add(
          `what-if: Aave HF at our estimated price ≈ 1 (±${tolerance}${exactCase ? ', single collateral' : ', mixed collateral'}): ${tag}`,
          Math.abs(hfAfter - 1) <= tolerance && restored === originalCode,
          `drop ${(est.dropFraction * 100).toFixed(2)}% in ${est.asset} (share ${(est.share * 100).toFixed(1)}%) -> Aave HF ${hfAfter.toFixed(4)}; fork restored: ${restored === originalCode}`,
        );
      }
    }

    // Two reads must give identical results (deterministic at a pinned block).
    const again = await new OnChainDataSource({ addresses: { [network]: market }, callers: { [network]: caller }, now: () => now, minRequestIntervalMs: 0 })
      .getPositions(wallets.map((w) => ({ network, wallet: w.wallet })));
    add('deterministic (2 reads identical)', JSON.stringify(again) === JSON.stringify(results), '');

    const fixture: ForkFixture = {
      _comment: 'Recorded by scripts/fork-validate.ts from a LOCAL Anvil fork at a pinned block. Public on-chain data only.',
      network,
      chainId: net.chain.id,
      forkBlock: block.toString(),
      forkTimestamp,
      recordedNow: now,
      market,
      wallets,
      blockNumbers: [...new Set(blocks)],
      calls: dedupe(record),
      expected: results.map(stripVolatile),
      whatIfChecks,
      checks,
    };
    mkdirSync('tests/fixtures/fork', { recursive: true });
    const file = `tests/fixtures/fork/${network}-${block}.json`;
    writeFileSync(file, JSON.stringify(fixture, null, 1) + '\n');
    console.log(`fixture written: ${file} (${fixture.calls.length} recorded calls)`);
    return checks;
  } finally {
    anvil.kill();
  }
}

function dedupe(calls: RecordedCall[]) {
  const m = new Map<string, RecordedCall>();
  for (const c of calls) m.set(c.key, c);
  return [...m.values()];
}

function stripVolatile(r: PositionReadResult) {
  return { ...r, fetchedAt: 0 };
}

async function main() {
  const networks = (process.argv.slice(2).length ? process.argv.slice(2) : ['ethereum', 'arbitrum']) as NetworkKey[];
  const addresses = loadVerifiedAddresses();
  const all: Check[] = [];
  for (const [i, n] of networks.entries()) {
    const market = addresses[n];
    if (!market) throw new Error(`No verified addresses for ${n}`);
    all.push(...(await validateNetwork(n, market, 8545 + i)));
  }
  const failed = all.filter((c) => !c.pass);
  console.log(`\nSUMMARY: ${all.length - failed.length}/${all.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message.split('\n')[0] : err);
  process.exit(1);
});
