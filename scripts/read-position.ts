// Manual smoke test: read one live Aave V3 position (read-only).
//
//   npm run read:position -- <network> <address>
//   npm run read:position -- <network> --recent-borrower   (picks a borrower from recent public Borrow events)
import { createPublicClient, fallback, http, parseAbiItem, type Address, type PublicClient } from 'viem';
import { loadVerifiedAddresses } from '../src/chain/addresses.js';
import { createViemCaller } from '../src/chain/caller.js';
import { NETWORKS, rpcUrlsFor, type NetworkKey } from '../src/chain/networks.js';
import { parseWalletAddress } from '../src/core/address.js';
import { OnChainDataSource } from '../src/datasources/onchain.js';
import { estimateLiquidationPriceDrop } from '../src/risk/whatIf.js';

const borrowEvent = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
);

async function findRecentBorrower(network: NetworkKey, pool: Address): Promise<Address> {
  const net = NETWORKS[network];
  const client = createPublicClient({ chain: net.chain, transport: fallback(rpcUrlsFor(net).map((u) => http(u))) }) as PublicClient;
  const latest = await client.getBlockNumber();
  for (const span of [1_000n, 5_000n, 20_000n]) {
    const logs = await client.getLogs({ address: pool, event: borrowEvent, fromBlock: latest - span, toBlock: latest }).catch(() => []);
    const last = logs.at(-1);
    if (last?.args.onBehalfOf) return last.args.onBehalfOf;
  }
  throw new Error('No recent Borrow event found');
}

async function main() {
  const [networkArg, target] = process.argv.slice(2);
  const network = networkArg as NetworkKey;
  const addresses = loadVerifiedAddresses();
  const market = addresses[network];
  if (!market) throw new Error(`Unknown or unverified network "${networkArg}". Verified: ${Object.keys(addresses).join(', ')}`);

  let wallet: Address;
  if (target === '--recent-borrower') {
    wallet = await findRecentBorrower(network, market.pool);
    console.log(`Recent borrower found in public Borrow events: ${wallet}`);
  } else {
    const parsed = parseWalletAddress(target ?? '');
    if (!parsed.ok) throw new Error(parsed.reason);
    wallet = parsed.address;
  }

  const source = new OnChainDataSource({
    addresses,
    callers: { [network]: createViemCaller({ network, multicall3: market.multicall3 }) },
  });
  const [result] = await source.getPositions([{ network, wallet }]);
  console.log(JSON.stringify(result, null, 2));
  if (result?.snapshot) console.log('\nWhat-if estimate:', JSON.stringify(estimateLiquidationPriceDrop(result.snapshot), null, 2));
  console.log('\nNetwork health:', JSON.stringify(source.getNetworkHealth().filter((h) => h.network === network)));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
