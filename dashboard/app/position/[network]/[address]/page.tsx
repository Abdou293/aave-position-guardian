'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { HfChart } from '@/components/HfChart';
import { Loading, RiskBadge, Status } from '@/components/bits';
import { usePolling, type AssetPosition, type PositionDetail, type WhatIf } from '@/lib/api';
import { ago, hf, pct, usd } from '@/lib/format';

const RANGES = [
  { hours: 1, label: '1 h' },
  { hours: 6, label: '6 h' },
  { hours: 24, label: '24 h' },
  { hours: 168, label: '7 days' },
];

export default function PositionPage() {
  const params = useParams<{ network: string; address: string }>();
  const [hours, setHours] = useState(6);
  const path = `/api/positions/${encodeURIComponent(params.network)}/${encodeURIComponent(params.address)}?hours=${hours}`;
  const { data: p, error, loading } = usePolling<PositionDetail>(path, 15_000);

  if (loading && !p) return <Loading what="position" />;
  if (!p) {
    return (
      <>
        <h1>Position</h1>
        <div className="banner error">{error?.message ?? 'Not found'}</div>
        <p><Link href="/">← Back to positions</Link></p>
      </>
    );
  }

  return (
    <>
      <p style={{ margin: '18px 0 0' }}>
        <Link href="/">← Positions</Link>
      </p>
      <h1>
        {p.networkName} · <span className="mono">{p.address}</span>
      </h1>
      <p className="sub">
        {p.labels.join(', ') || 'No label'} · <Status value={p.status} title={p.error ?? undefined} /> · data{' '}
        {p.dataAgeMs !== null ? ago(p.dataAgeMs) : 'not read yet'}
        {p.snapshot?.blockNumber ? ` · block ${p.snapshot.blockNumber}` : ''}
        {p.source === 'simulated' ? ' · simulated data' : ''}
      </p>
      {p.status !== 'ok' && p.status !== 'none' && (
        <div className="banner warn">
          The latest read failed ({p.error ?? p.status}). The values below are the last good reading from {ago(p.dataAgeMs)}.
        </div>
      )}

      <div className="grid kpis" style={{ marginTop: 16 }}>
        <div className="card kpi">
          <div className="label">Health factor</div>
          <div className="value">{p.hasDebt === false ? '∞ (no debt)' : hf(p.healthFactor)}</div>
          <RiskBadge risk={p.risk} />
        </div>
        <div className="card kpi">
          <div className="label">Collateral</div>
          <div className="value">{usd(p.totalCollateralUsd)}</div>
        </div>
        <div className="card kpi">
          <div className="label">Debt</div>
          <div className="value">{usd(p.totalDebtUsd)}</div>
        </div>
        <div className="card kpi">
          <div className="label">Liq. threshold / LTV</div>
          <div className="value">
            {p.snapshot ? `${pct(p.snapshot.liquidationThreshold)} / ${pct(p.snapshot.ltv)}` : '—'}
          </div>
          {p.snapshot && p.snapshot.eModeCategory > 0 && <div className="muted small">E-Mode category {p.snapshot.eModeCategory}</div>}
        </div>
      </div>

      <h2>Health factor history</h2>
      <div className="card">
        <div className="tabs" role="tablist" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.hours} role="tab" aria-selected={hours === r.hours} className={hours === r.hours ? 'active' : ''} onClick={() => setHours(r.hours)}>
              {r.label}
            </button>
          ))}
        </div>
        <HfChart points={p.history} thresholds={p.thresholds} />
        <p className="muted small" style={{ marginBottom: 0 }}>
          Long ranges are compressed to at most 400 points; each point shows the <strong>lowest</strong> health factor in its
          time slice, so short dips are never hidden. Gaps mean a read failed.
        </p>
      </div>

      <h2>What-if estimate</h2>
      <WhatIfCard w={p.whatIf} />

      {p.snapshot && (
        <>
          <h2>Assets</h2>
          {!p.snapshot.assetBreakdownAvailable ? (
            <div className="banner warn">The per-asset breakdown could not be read. The totals above are still the official values.</div>
          ) : (
            <div className="two-col">
              <AssetTable title="Collateral" rows={p.snapshot.collateral} />
              <AssetTable title="Debt" rows={p.snapshot.debts} />
            </div>
          )}
        </>
      )}
    </>
  );
}

function WhatIfCard({ w }: { w: WhatIf | null }) {
  if (!w) return <div className="card muted">No reading yet.</div>;
  if (w.kind !== 'estimate' && w.kind !== 'not-reachable') return <div className="card">{w.message}</div>;
  return (
    <div className="card">
      <p style={{ marginTop: 0 }}>
        <span className="badge risk-unknown">ESTIMATE · not an Aave value</span>
      </p>
      <p style={{ fontSize: 16 }}>{w.message}</p>
      {w.kind === 'estimate' && (
        <p className="muted">
          {w.asset}: now {usd(w.currentPriceUsd, true)} → about {usd(w.estimatedLiquidationPriceUsd, true)} ({pct(w.dropFraction)} lower).
          It is {pct(w.share, 0)} of the collateral.
        </p>
      )}
      <div className="formula mono">{w.formula}</div>
      <p className="muted small" style={{ marginBottom: 0 }}>Limits of this estimate:</p>
      <ul className="tight muted small">
        {w.assumptions.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
    </div>
  );
}

function AssetTable({ title, rows }: { title: string; rows: AssetPosition[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{title}</th>
            <th className="num">Amount</th>
            <th className="num">Price</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">None</td>
            </tr>
          ) : (
            rows.map((a) => (
              <tr key={a.asset}>
                <td>{a.symbol}</td>
                <td className="num">{a.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                <td className="num">{usd(a.priceUsd, true)}</td>
                <td className="num">{usd(a.valueUsd)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
