// Turns an AlertEvent into a short plain-text message (used by Telegram and the dashboard log).
// Plain text on purpose: no Markdown escaping bugs, and it reads well everywhere.
import type { NetworkKey } from '../chain/networks.js';
import { estimateLiquidationPriceDrop } from '../risk/whatIf.js';
import type { AlertEvent } from './engine.js';

export const NETWORK_NAMES: Record<NetworkKey, string> = {
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  base: 'Base',
  polygon: 'Polygon',
};

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;

const DISCLAIMER = 'Not financial advice. Alerts can be delayed or fail.';

export function formatAlert(ev: AlertEvent): string {
  const where = `${NETWORK_NAMES[ev.network]} · ${shortAddress(ev.wallet)}`;
  const hf = ev.healthFactor === null ? 'no debt' : ev.healthFactor.toFixed(3);
  const lines: string[] = [];

  switch (ev.kind) {
    case 'threshold-crossed':
    case 'critical-repeat': {
      const icon = ev.severity === 'critical' ? '🚨' : '⚠️';
      const title = ev.kind === 'critical-repeat' ? 'CRITICAL (reminder)' : ev.severity === 'critical' ? 'CRITICAL' : 'Warning';
      lines.push(`${icon} ${title}: health factor ${hf} (below ${ev.threshold})`, where);
      if (ev.liquidatable) lines.push('Health factor is at or below 1: this position can be liquidated NOW.');
      if (ev.snapshot) {
        lines.push(`Collateral ${usd(ev.snapshot.totalCollateralUsd)} · Debt ${usd(ev.snapshot.totalDebtUsd)}`);
        const whatIf = estimateLiquidationPriceDrop(ev.snapshot);
        if (whatIf.kind === 'estimate' || whatIf.kind === 'not-reachable') lines.push(whatIf.message);
      }
      lines.push('Options: add collateral or repay part of the debt.');
      break;
    }
    case 'recovered':
      lines.push(`✅ Recovered: health factor ${hf}`, where, ev.reason);
      break;
    case 'monitoring-degraded':
      lines.push('📡 Monitoring degraded: no fresh data', where, `${ev.reason} Last error: ${ev.dataError ?? 'unknown'}`);
      lines.push('Your position is NOT being watched right now. Please check it yourself.');
      break;
    case 'monitoring-restored':
      lines.push('📡 Monitoring restored', where, `Fresh data again. Health factor ${hf}.`);
      break;
  }
  lines.push(DISCLAIMER);
  return lines.join('\n');
}
