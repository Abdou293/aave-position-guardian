// Loads ONLY the addresses that scripts/verify-addresses.ts verified on-chain.
// A network missing from config/addresses.json is treated as unsupported.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAddress, type Address } from 'viem';
import type { NetworkKey } from './networks.js';

export interface MarketAddresses {
  chainId: number;
  pool: Address;
  poolAddressesProvider: Address;
  oracle: Address;
  poolDataProvider: Address;
  uiPoolDataProvider: Address;
  multicall3: Address;
}

export type VerifiedAddresses = Partial<Record<NetworkKey, MarketAddresses>>;

export function loadVerifiedAddresses(
  file = process.env.ADDRESSES_FILE ?? resolve(process.cwd(), 'config/addresses.json'),
): VerifiedAddresses {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { networks?: Record<string, Record<string, unknown>> };
  const out: VerifiedAddresses = {};
  for (const [network, entry] of Object.entries(raw.networks ?? {})) {
    const addr = (k: string) => getAddress(String(entry[k])); // throws on a malformed address
    out[network as NetworkKey] = {
      chainId: Number(entry.chainId),
      pool: addr('pool'),
      poolAddressesProvider: addr('poolAddressesProvider'),
      oracle: addr('oracle'),
      poolDataProvider: addr('poolDataProvider'),
      uiPoolDataProvider: addr('uiPoolDataProvider'),
      multicall3: addr('multicall3'),
    };
  }
  return out;
}
