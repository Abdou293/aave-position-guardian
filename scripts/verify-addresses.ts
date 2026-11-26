// Verifies every contract address this project uses, ON-CHAIN, before we trust it.
//
// Source of the addresses (never typed by hand):
//   - Aave V3: the official Aave address book (npm package @bgd-labs/aave-address-book,
//     maintained by BGD Labs for Aave governance; https://github.com/bgd-labs/aave-address-book)
//   - Multicall3: the canonical deployment from https://github.com/mds1/multicall3
//     (the same address is also built into viem's chain definitions, which we cross-check)
//
// On-chain checks for each network (read-only calls, nothing is ever sent or signed):
//   1. The RPC really is the expected chain (chainId).
//   2. Every address has contract code.
//   3. The PoolAddressesProvider (the protocol's on-chain "registry") points to the SAME
//      Pool, Oracle and PoolDataProvider that the address book lists.
//   4. Pool, Oracle and PoolDataProvider each point back to that same provider.
//   5. The Pool returns a non-empty reserve list, and the UiPoolDataProvider can read it.
//   6. Multicall3 reports the right chainId and has identical bytecode on every network.
//
// Only networks that pass ALL checks are written to config/addresses.json.
// Usage: npm run verify:addresses
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import { AaveV3Arbitrum, AaveV3Base, AaveV3Ethereum, AaveV3Polygon } from '@bgd-labs/aave-address-book';
import { NETWORKS, NETWORK_KEYS, redactRpcUrl, rpcUrlsFor, type NetworkKey } from '../src/chain/networks.js';

/** Canonical Multicall3 address (same on all EVM chains), from github.com/mds1/multicall3. */
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

const BOOK = {
  ethereum: AaveV3Ethereum,
  arbitrum: AaveV3Arbitrum,
  base: AaveV3Base,
  polygon: AaveV3Polygon,
} as const satisfies Record<NetworkKey, unknown>;

const providerAbi = parseAbi([
  'function getPool() view returns (address)',
  'function getPriceOracle() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
]);
const pointsToProviderAbi = parseAbi(['function ADDRESSES_PROVIDER() view returns (address)']);
const poolAbi = parseAbi(['function getReservesList() view returns (address[])']);
const uiProviderAbi = parseAbi(['function getReservesList(address provider) view returns (address[])']);
const multicallAbi = parseAbi(['function getChainId() view returns (uint256)']);

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

interface NetworkResult {
  network: NetworkKey;
  chainId: number;
  ok: boolean;
  blockNumber?: string;
  rpc?: string;
  checks: Check[];
  addresses?: Record<string, Address>;
  multicallCodeHash?: string;
}

const same = (a: string, b: string) => getAddress(a) === getAddress(b);

async function verifyNetwork(key: NetworkKey): Promise<NetworkResult> {
  const net = NETWORKS[key];
  const book = BOOK[key];
  const urls = rpcUrlsFor(net);
  const client = createPublicClient({
    chain: net.chain,
    transport: fallback(urls.map((u) => http(u, { timeout: 15_000, retryCount: 2 }))),
  }) as PublicClient;

  const addresses = {
    pool: getAddress(book.POOL),
    poolAddressesProvider: getAddress(book.POOL_ADDRESSES_PROVIDER),
    oracle: getAddress(book.ORACLE),
    poolDataProvider: getAddress(book.AAVE_PROTOCOL_DATA_PROVIDER),
    uiPoolDataProvider: getAddress(book.UI_POOL_DATA_PROVIDER),
    multicall3: MULTICALL3,
  };

  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  const result: NetworkResult = {
    network: key,
    chainId: net.chain.id,
    ok: false,
    rpc: urls.map(redactRpcUrl).join(' | '),
    checks,
  };

  try {
    // 0. Address book agrees with our chain id.
    check('address book CHAIN_ID matches', book.CHAIN_ID === net.chain.id, `book=${book.CHAIN_ID}`);

    // 1. RPC is the right chain.
    const rpcChainId = await client.getChainId();
    check('RPC chainId matches', rpcChainId === net.chain.id, `rpc=${rpcChainId}`);
    result.blockNumber = (await client.getBlockNumber()).toString();

    // 2. Contract code exists at every address.
    for (const [label, addr] of Object.entries(addresses)) {
      const code = await client.getCode({ address: addr });
      check(`${label} has contract code`, !!code && code !== '0x', addr);
    }

    // 3. The on-chain registry points to the same addresses as the address book.
    const p = addresses.poolAddressesProvider;
    const [regPool, regOracle, regDataProvider] = await Promise.all([
      client.readContract({ address: p, abi: providerAbi, functionName: 'getPool' }),
      client.readContract({ address: p, abi: providerAbi, functionName: 'getPriceOracle' }),
      client.readContract({ address: p, abi: providerAbi, functionName: 'getPoolDataProvider' }),
    ]);
    check('provider.getPool() == POOL', same(regPool, addresses.pool), regPool);
    check('provider.getPriceOracle() == ORACLE', same(regOracle, addresses.oracle), regOracle);
    check('provider.getPoolDataProvider() == DATA_PROVIDER', same(regDataProvider, addresses.poolDataProvider), regDataProvider);

    // 4. Each core contract points back to the same provider.
    for (const label of ['pool', 'oracle', 'poolDataProvider'] as const) {
      const back = await client.readContract({
        address: addresses[label],
        abi: pointsToProviderAbi,
        functionName: 'ADDRESSES_PROVIDER',
      });
      check(`${label}.ADDRESSES_PROVIDER() == provider`, same(back, p), back);
    }

    // 5. Pool has reserves and the UI data provider can read them.
    const reserves = await client.readContract({ address: addresses.pool, abi: poolAbi, functionName: 'getReservesList' });
    check('pool.getReservesList() is not empty', reserves.length > 0, `${reserves.length} reserves`);
    const uiReserves = await client.readContract({
      address: addresses.uiPoolDataProvider,
      abi: uiProviderAbi,
      functionName: 'getReservesList',
      args: [p],
    });
    check('uiPoolDataProvider reads the same reserves', uiReserves.length === reserves.length, `${uiReserves.length} reserves`);

    // 6. Multicall3 is the real one on this chain.
    const mcChainId = await client.readContract({ address: MULTICALL3, abi: multicallAbi, functionName: 'getChainId' });
    check('multicall3.getChainId() matches', Number(mcChainId) === net.chain.id, mcChainId.toString());
    const viemMc = net.chain.contracts?.multicall3?.address;
    check('multicall3 matches viem chain config', !!viemMc && same(viemMc, MULTICALL3), viemMc ?? 'missing');
    const mcCode = await client.getCode({ address: MULTICALL3 });
    result.multicallCodeHash = mcCode ? keccak256(mcCode) : undefined;
  } catch (err) {
    check('RPC calls succeeded', false, (err as Error).message.split('\n')[0]);
  }

  result.ok = checks.length > 0 && checks.every((c) => c.ok);
  if (result.ok) result.addresses = addresses;
  return result;
}

async function main() {
  // The package does not export its package.json, so read the installed copy directly.
  const bookVersion = JSON.parse(
    readFileSync('node_modules/@bgd-labs/aave-address-book/package.json', 'utf8'),
  ).version as string;

  console.log(`Aave address book version: ${bookVersion}`);
  console.log('Verifying addresses on-chain (read-only)...\n');

  const results = await Promise.all(NETWORK_KEYS.map(verifyNetwork));

  // Multicall3 must have byte-identical code on every chain (it was deployed deterministically).
  const hashes = new Set(results.map((r) => r.multicallCodeHash).filter(Boolean));
  const multicallConsistent = hashes.size === 1;

  for (const r of results) {
    console.log(`=== ${r.network} (chainId ${r.chainId}) — ${r.ok ? 'PASS' : 'FAIL'}${r.blockNumber ? ` at block ${r.blockNumber}` : ''}`);
    console.log(`    rpc: ${r.rpc}`);
    for (const c of r.checks) console.log(`    ${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
    console.log('');
  }
  console.log(`${multicallConsistent ? '✔' : '✘'} Multicall3 bytecode identical on all checked networks (${hashes.size} distinct hash)`);

  const verified = results.filter((r) => r.ok && multicallConsistent);
  const output = {
    _comment: 'GENERATED by scripts/verify-addresses.ts. Do not edit by hand. Only on-chain verified networks are listed.',
    source: {
      aave: `@bgd-labs/aave-address-book@${bookVersion}`,
      multicall3: 'https://github.com/mds1/multicall3',
    },
    verifiedAt: new Date().toISOString(),
    networks: Object.fromEntries(
      verified.map((r) => [r.network, { chainId: r.chainId, verifiedAtBlock: r.blockNumber, ...r.addresses }]),
    ),
    notVerified: results.filter((r) => !verified.includes(r)).map((r) => r.network),
  };
  mkdirSync('config', { recursive: true });
  writeFileSync('config/addresses.json', JSON.stringify(output, null, 2) + '\n');

  console.log(`\nVerified: ${verified.map((r) => r.network).join(', ') || 'none'}`);
  if (output.notVerified.length) {
    console.log(`NOT verified (will not be used): ${output.notVerified.join(', ')}`);
    process.exitCode = 1;
  }
  console.log('Wrote config/addresses.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
