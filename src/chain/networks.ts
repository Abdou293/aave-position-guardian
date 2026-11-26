// Supported networks and their RPC endpoints.
//
// RPC URLs from .env (e.g. RPC_URL_ARBITRUM) are tried first. If none is set,
// free public endpoints are used. Public endpoints are rate-limited and can be
// unreliable; they are fine for development and the address check.
import { arbitrum, base, mainnet, polygon, type Chain } from 'viem/chains';

export type NetworkKey = 'ethereum' | 'arbitrum' | 'base' | 'polygon';

export interface NetworkConfig {
  key: NetworkKey;
  chain: Chain;
  /** Name of the env variable that can override the RPC URL. */
  rpcEnvVar: string;
  /** Free public RPC endpoints, used when no env override is set. */
  publicRpcUrls: string[];
}

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  ethereum: {
    key: 'ethereum',
    chain: mainnet,
    rpcEnvVar: 'RPC_URL_ETHEREUM',
    publicRpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.merkle.io'],
  },
  arbitrum: {
    key: 'arbitrum',
    chain: arbitrum,
    rpcEnvVar: 'RPC_URL_ARBITRUM',
    publicRpcUrls: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
  },
  base: {
    key: 'base',
    chain: base,
    rpcEnvVar: 'RPC_URL_BASE',
    publicRpcUrls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  },
  polygon: {
    key: 'polygon',
    chain: polygon,
    rpcEnvVar: 'RPC_URL_POLYGON',
    publicRpcUrls: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
  },
};

export const NETWORK_KEYS = Object.keys(NETWORKS) as NetworkKey[];

/** RPC URLs for a network: the env override first (if set), then public fallbacks. */
export function rpcUrlsFor(net: NetworkConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env[net.rpcEnvVar]?.trim();
  return override ? [override, ...net.publicRpcUrls] : [...net.publicRpcUrls];
}

/** Hides API keys in a URL before it is printed or logged. */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts.at(-1);
    if (last && last.length >= 16) parts[parts.length - 1] = '***';
    return `${u.protocol}//${u.host}/${parts.join('/')}`;
  } catch {
    return '<invalid url>';
  }
}
