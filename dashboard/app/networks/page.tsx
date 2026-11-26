'use client';
import { Loading, Status } from '@/components/bits';
import { usePolling, type NetworksResponse } from '@/lib/api';
import { ago, time } from '@/lib/format';

const SOURCE_LABEL = {
  simulated: 'Simulated (demo)',
  custom: 'Your RPC endpoint',
  public: 'Public RPC (shared, can be slow)',
};

export default function NetworksPage() {
  const { data, loading } = usePolling<NetworksResponse>('/api/networks', 15_000);
  if (loading && !data) return <Loading what="network health" />;
  if (!data) return null;
  const monitorAge = data.monitor.lastCycleAt ? data.at - data.monitor.lastCycleAt : null;
  const monitorLate = monitorAge === null || monitorAge > 3 * data.pollIntervalMs;

  return (
    <>
      <h1>Network health</h1>
      <p className="sub">Is the data fresh? If a network is degraded or down, alerts for it can be late or missing.</p>

      <div className="grid kpis" style={{ marginBottom: 16 }}>
        <div className="card kpi">
          <div className="label">Last monitoring cycle</div>
          <div className="value" style={{ color: monitorLate ? 'var(--warning)' : undefined }}>
            {monitorAge === null ? 'not yet' : ago(monitorAge)}
          </div>
          <div className="muted small">runs every {Math.round(data.pollIntervalMs / 1000)} s</div>
        </div>
      </div>
      {data.monitor.lastCycleError && <div className="banner error">Last cycle failed: {data.monitor.lastCycleError}</div>}
      {monitorLate && monitorAge !== null && (
        <div className="banner warn">
          The monitor has not completed a cycle recently. On free hosting this usually means the server was asleep. Alerts
          during that time were not sent.
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Network</th>
              <th>Status</th>
              <th>Data source</th>
              <th>Last success</th>
              <th className="num">Last block</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {data.networks.map((n) => (
              <tr key={n.network}>
                <td><strong>{n.name}</strong></td>
                <td>
                  <Status value={n.status} />
                  {n.consecutiveFailures > 0 && <div className="muted small">{n.consecutiveFailures} failure(s) in a row</div>}
                </td>
                <td className="small">{SOURCE_LABEL[n.source]}</td>
                <td className="small">{n.lastSuccessAt ? `${ago(data.at - n.lastSuccessAt)}` : 'never'}</td>
                <td className="num mono small">{n.lastBlockNumber ?? '—'}</td>
                <td className="small">
                  {n.lastError ? (
                    <>
                      <span className="st-error">{n.lastError}</span>
                      <div className="muted">{time(n.lastErrorAt)}</div>
                    </>
                  ) : (
                    <span className="muted">none</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
