// Format of the fork fixtures recorded by scripts/fork-validate.ts, plus a replaying ChainCaller
// so the on-chain reader can be tested offline against REAL recorded Aave data.
import type { Address } from 'viem';
import type { MarketAddresses } from '../../src/chain/addresses.js';
import type { CallResult, ChainCaller, ContractCall } from '../../src/chain/caller.js';
import type { NetworkKey } from '../../src/chain/networks.js';
import type { PositionReadResult } from '../../src/core/types.js';

export interface RecordedCall {
  key: string;
  result: { status: 'success'; value: unknown } | { status: 'failure'; error: string };
}

export interface ForkFixture {
  _comment: string;
  network: NetworkKey;
  chainId: number;
  forkBlock: string;
  forkTimestamp: number;
  recordedNow: number;
  market: MarketAddresses;
  wallets: Array<{ wallet: Address; why: string }>;
  blockNumbers: string[];
  calls: RecordedCall[];
  expected: PositionReadResult[];
  whatIfChecks: Array<{
    wallet: Address;
    asset: string;
    share: number;
    dropFraction: number;
    estimatedLiquidationPriceUsd: number;
    aaveHealthFactorAtThatPrice: number;
  }>;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
}

/** JSON-safe encoding (bigint → {"$n": "..."}). */
export function encodeFixtureValue(v: unknown): unknown {
  if (typeof v === 'bigint') return { $n: v.toString() };
  if (Array.isArray(v)) return v.map(encodeFixtureValue);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeFixtureValue(x)]));
  return v;
}

export function decodeFixtureValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeFixtureValue);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$n === 'string' && Object.keys(o).length === 1) return BigInt(o.$n);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decodeFixtureValue(x)]));
  }
  return v;
}

const keyOf = (c: ContractCall) => `${c.address.toLowerCase()}.${c.functionName}(${JSON.stringify(encodeFixtureValue(c.args ?? []))})`;

/** Answers calls ONLY from the recording. An unrecorded call is a test failure, never a network call. */
export class ReplayCaller implements ChainCaller {
  private readonly byKey: Map<string, RecordedCall['result']>;
  readonly missing: string[] = [];

  constructor(private readonly fixture: ForkFixture) {
    this.byKey = new Map(fixture.calls.map((c) => [c.key, c.result]));
  }

  async multicall(calls: ContractCall[]): Promise<CallResult[]> {
    return calls.map((c) => {
      const r = this.byKey.get(keyOf(c));
      if (!r) {
        this.missing.push(keyOf(c));
        return { status: 'failure', error: new Error('not recorded') };
      }
      return r.status === 'success' ? { status: 'success', result: decodeFixtureValue(r.value) } : { status: 'failure', error: new Error(r.error) };
    });
  }

  async getBlockNumber(): Promise<bigint> {
    return BigInt(this.fixture.blockNumbers[0] ?? this.fixture.forkBlock);
  }
}
