'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Loading, Status } from '@/components/bits';
import { useMeta } from '@/components/Shell';
import { usePolling, type AlertItem, type AuditItem } from '@/lib/api';
import { hf, shortAddress, time } from '@/lib/format';

const STATUS_HELP: Record<AlertItem['status'], string> = {
  pending: 'Saved, waiting to be sent',
  sending: 'Being sent now',
  sent: 'Delivered',
  failed: 'Not delivered (gave up or expired)',
  uncertain: 'The app stopped while sending; not resent, to avoid a duplicate',
};

export default function AlertsPage() {
  const meta = useMeta();
  const [tab, setTab] = useState<'alerts' | 'audit'>('alerts');
  const alerts = usePolling<{ alerts: AlertItem[] }>(tab === 'alerts' ? '/api/alerts?limit=200' : null, 15_000);
  const audit = usePolling<{ audit: AuditItem[] }>(tab === 'audit' ? '/api/audit?limit=200' : null, 15_000);

  return (
    <>
      <h1>Alerts log</h1>
      <p className="sub">
        {meta?.mode === 'demo'
          ? 'Alerts generated for the demo positions (shown here only, not sent to anyone).'
          : 'Every alert queued for Telegram, and what happened to it.'}{' '}
        The audit log also shows alerts that were <em>deliberately not sent</em> (cooldown, hysteresis, pause) and why.
      </p>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'alerts'} className={tab === 'alerts' ? 'active' : ''} onClick={() => setTab('alerts')}>
          Alerts
        </button>
        <button role="tab" aria-selected={tab === 'audit'} className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
          Audit log (decisions)
        </button>
      </div>

      {tab === 'alerts' ? (
        alerts.loading && !alerts.data ? (
          <Loading what="alerts" />
        ) : !alerts.data?.alerts.length ? (
          <div className="card muted">No alerts yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Position</th>
                  <th>Alert</th>
                  <th className="num">HF</th>
                  <th>Delivery</th>
                </tr>
              </thead>
              <tbody>
                {alerts.data.alerts.map((a) => (
                  <tr key={a.id}>
                    <td className="small">{time(a.createdAt)}</td>
                    <td>
                      <Link href={`/position/${a.network}/${a.address}`} className="mono">{shortAddress(a.address)}</Link>
                      <div className="muted small">{a.network}</div>
                    </td>
                    <td>
                      <strong className={`sev-${a.severity}`}>{a.message.split('\n')[0]}</strong>
                      <div className="muted small">{a.kind}</div>
                    </td>
                    <td className="num">{hf(a.healthFactor)}</td>
                    <td>
                      <Status value={a.status} title={STATUS_HELP[a.status]} />
                      <div className="muted small">
                        {a.sentAt ? `at ${time(a.sentAt)}` : a.lastError ?? STATUS_HELP[a.status]}
                        {a.attempts > 1 ? ` · ${a.attempts} attempts` : ''}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : audit.loading && !audit.data ? (
        <Loading what="audit log" />
      ) : !audit.data?.audit.length ? (
        <div className="card muted">No decisions recorded yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Position</th>
                <th>Event</th>
                <th>Decision</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.audit.map((r, i) => (
                <tr key={`${r.at}:${i}`}>
                  <td className="small">{time(r.at)}</td>
                  <td className="mono small">{r.address ? shortAddress(r.address) : '—'}</td>
                  <td className="small">{r.kind}</td>
                  <td>
                    <span className={r.decision === 'emit' ? 'st-ok' : 'muted'}>{r.decision === 'emit' ? 'sent' : 'suppressed'}</span>
                  </td>
                  <td className="small">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
