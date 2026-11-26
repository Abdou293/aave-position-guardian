'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, type ReactNode } from 'react';
import { apiPost, usePolling, type Meta } from '@/lib/api';

const MetaContext = createContext<Meta | null>(null);
export const useMeta = () => useContext(MetaContext);

const LINKS = [
  { href: '/', label: 'Positions' },
  { href: '/alerts', label: 'Alerts log' },
  { href: '/networks', label: 'Network health' },
];

const FALLBACK_DISCLAIMER =
  'Not financial advice. This tool is read-only and non-custodial. Alerts can be delayed or fail; it cannot guarantee you avoid liquidation. Not audited.';

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: meta, error } = usePolling<Meta>('/api/meta', 60_000);

  const logout = async () => {
    await apiPost('/api/logout', {}).catch(() => undefined);
    window.location.href = '/login';
  };

  return (
    <MetaContext.Provider value={meta}>
      <header className="topbar">
        <div className="container">
          <Link href="/" className="brand" aria-label="Aave Position Guardian home">
            <span aria-hidden>🛡️</span> Aave Position Guardian
          </Link>
          <nav className="nav" aria-label="Main">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className={pathname === l.href ? 'active' : ''}>
                {l.label}
              </Link>
            ))}
          </nav>
          {meta && <span className={`pill ${meta.mode}`}>{meta.mode === 'demo' ? 'DEMO · simulated data' : 'LIVE · on-chain'}</span>}
          <span className="pill" title="This app never asks for keys and never sends transactions">🔒 Read-only</span>
          {meta?.mode === 'live' && meta.authenticated && <button onClick={logout}>Log out</button>}
        </div>
      </header>

      <div className="container">
        {meta?.mode === 'demo' && (
          <div className="banner demo" role="note">
            <strong>Demo mode:</strong> all positions here are <strong>simulated</strong> (no real wallets, no real money). The
            “liquidation drill” position falls toward liquidation and recovers every 30 minutes so you can watch the alerts work.
          </div>
        )}
        {error && error.status !== 401 && (
          <div className="banner error" role="alert">
            {error.message}
          </div>
        )}
        <main>{children}</main>
      </div>

      <footer>
        <div className="container">
          <strong>⚠️ {meta?.disclaimer ?? FALLBACK_DISCLAIMER}</strong>
          <div style={{ marginTop: 6 }}>
            Health factor, collateral and debt are read from the official Aave V3 contracts. The “what-if” figure is our own
            estimate and is always labelled as such.
          </div>
        </div>
      </footer>
    </MetaContext.Provider>
  );
}
