// Tracks, per network, when the last read worked and what the last error was.
// The dashboard's health page shows this.
import type { NetworkKey } from '../chain/networks.js';
import type { NetworkHealth } from '../core/types.js';

export class NetworkHealthTracker {
  private readonly state = new Map<NetworkKey, NetworkHealth>();

  constructor(networks: NetworkKey[]) {
    for (const network of networks) {
      this.state.set(network, {
        network,
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
        consecutiveFailures: 0,
        lastBlockNumber: null,
      });
    }
  }

  recordSuccess(network: NetworkKey, at: number, blockNumber: number | null): void {
    const s = this.get(network);
    s.lastSuccessAt = at;
    s.consecutiveFailures = 0;
    if (blockNumber !== null) s.lastBlockNumber = blockNumber;
  }

  recordFailure(network: NetworkKey, at: number, error: string): void {
    const s = this.get(network);
    s.lastErrorAt = at;
    s.lastError = error;
    s.consecutiveFailures += 1;
  }

  snapshot(): NetworkHealth[] {
    return [...this.state.values()].map((s) => ({ ...s }));
  }

  private get(network: NetworkKey): NetworkHealth {
    let s = this.state.get(network);
    if (!s) {
      s = { network, lastSuccessAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0, lastBlockNumber: null };
      this.state.set(network, s);
    }
    return s;
  }
}
