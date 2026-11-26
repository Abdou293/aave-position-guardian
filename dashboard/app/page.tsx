'use client';
import Link from 'next/link';
import { Loading, RiskBadge, Status } from '@/components/bits';
import { useMeta } from '@/components/Shell';
import { usePolling, type PositionSummary } from '@/lib/api';
import { ago, hf, pct, shortAddress, usd } from '@/lib/format';

interface PositionsResponse {
  at: number;
  thresholds: number[];
  positions: PositionSummary[];
}

export default function PositionsPage() {
  const meta = useMeta();
  const { data, loading } = usePolling<PositionsResponse>('/api/positions', 15_000);
  const positions = data?.positions ?? [];
  const atRisk = positions.filter((p) => p.risk === 'warning' || p.risk === 'critical' || p.risk === 'liquidatable').length;
  const problems = positions.filter((p) => p.status === 'stale' || p.status === 'error').length;

  return (
    <>
      <h1>Positions</h1>
      <p className="sub">
        Riskiest first. Updates every {meta ? Math.round(meta.pollIntervalMs / 1000) : '…'} s.
        {data && <> Alert thresholds: {data.thresholds.join(' · ')}.</>}
      </p>

      <div className="grid kpis" style={{ marginBottom: 16 }}>
        <div className="card kpi">
          <div className="label">Watched positions</div>
          <div className="value">{data ? positions.length : '—'}</div>
        </div>
        <div className="card kpi">
          <div className="label">Below a threshold</div>
          <div className="value" style={{ color: atRisk ? 'var(--warning)' : undefined }}>{data ? atRisk : '—'}</div>
        </div>
        <div className="card kpi">
          <div className="label">Read problems</div>
          <div className="value" style={{ color: problems ? 'var(--critical)' : undefined }}>{data ? problems : '—'}</div>
        </div>
      </div>

      {loading && !data ? (
        <Loading what="positions" />
      ) : positions.length === 0 ? (
        <div className="card">
          No positions are being watched yet. Add a wallet with <code>/add</code> in the Telegram bot.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Position</th>
                <th>Network</th>
                <th className="num">Health factor</th>
                <th>Risk</th>
                <th className="num">Collateral</th>
                <th className="num">Debt</th>
                <th className="num" title="Our own estimate, not an Aave number. Open the position for the formula and its limits.">
                  Est. drop to HF 1 *
                </th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={`${p.network}:${p.address}`}>
                  <td>
                    <Link href={`/position/${p.network}/${p.address}`} className="mono">
                      {shortAddress(p.address)}
                    </Link>
                    {p.labels.length > 0 && <div className="muted small">{p.labels.join(', ')}</div>}
                  </td>
                  <td>{p.networkName}</td>
                  <td className="num">
                    <strong>{p.hasDebt === false ? '∞' : hf(p.healthFactor)}</strong>
                  </td>
                  <td>
                    <RiskBadge risk={p.risk} />
                  </td>
                  <td className="num">{usd(p.totalCollateralUsd)}</td>
                  <td className="num">{usd(p.totalDebtUsd)}</td>
                  <td className="num">
                    {p.whatIfDropFraction !== null ? `${pct(p.whatIfDropFraction)} ${p.whatIfAsset ?? ''}` : <span className="muted">—</span>}
                  </td>
                  <td>
                    <Status value={p.status} title={p.error ?? undefined} />
                    <div className="muted small">{p.dataAgeMs !== null ? ago(p.dataAgeMs) : 'no reading yet'}</div>
                    {p.status !== 'ok' && p.status !== 'none' && (
                      <div className="small st-stale">showing last good values</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        * Estimated fall in the main collateral asset&apos;s price that would bring the health factor to about 1, assuming
        everything else stays the same. An estimate, not a guarantee. Liquidation can happen earlier.
      </p>
    </>
  );
}
