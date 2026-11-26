// The one door to the blockchain: a batch of read-only calls sent through Multicall3.
// Tests replace this with a fake, so the reader logic is tested without any network.
import { createPublicClient, fallback, http, type Abi, type Address, type PublicClient } from 'viem';
import { NETWORKS, rpcUrlsFor, type NetworkKey } from './networks.js';

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type CallResult = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };

export interface ChainCaller {
  /**
   * Executes all calls in as few RPC requests as possible (Multicall3 aggregate3).
   * Individual call failures come back as `failure`; a transport failure throws.
   */
  multicall(calls: ContractCall[]): Promise<CallResult[]>;
  /**
   * Latest block number of THIS chain (eth_blockNumber). We do not use Multicall3.getBlockNumber
   * because on Arbitrum `block.number` inside a contract is the Ethereum L1 block number.
   */
  getBlockNumber(): Promise<bigint>;
}

export interface ViemCallerOptions {
  network: NetworkKey;
  multicall3: Address;
  /** Max calldata bytes per eth_call. Bigger = fewer requests (viem's default is 1024). */
  batchSize?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function createViemCaller(opts: ViemCallerOptions): ChainCaller {
  const net = NETWORKS[opts.network];
  const client = createPublicClient({
    chain: net.chain,
    // Try the configured RPC first, then public fallbacks. Retries are handled by the reader.
    transport: fallback(rpcUrlsFor(net, opts.env).map((url) => http(url, { timeout: opts.timeoutMs ?? 15_000, retryCount: 0 }))),
  }) as PublicClient;

  return {
    async multicall(calls) {
      const results = await client.multicall({
        // Our ContractCall is a looser type than viem's fully-inferred one.
        contracts: calls as never,
        allowFailure: true,
        multicallAddress: opts.multicall3,
        batchSize: opts.batchSize ?? 16_384,
      });
      return results as CallResult[];
    },
    getBlockNumber() {
      return client.getBlockNumber({ cacheTime: 0 });
    },
  };
}
