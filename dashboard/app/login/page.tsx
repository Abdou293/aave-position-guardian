'use client';
import { useState, type FormEvent } from 'react';
import { useMeta } from '@/components/Shell';
import { ApiError, apiPost } from '@/lib/api';

export default function LoginPage() {
  const meta = useMeta();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost('/api/login', { password });
      const next = new URLSearchParams(window.location.search).get('next');
      // Only same-site paths: never redirect to another website.
      window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  if (meta?.mode === 'demo') {
    return (
      <div className="card" style={{ maxWidth: 460, margin: '40px auto' }}>
        <h1 style={{ marginTop: 0 }}>No login needed</h1>
        <p>This is the public demo with simulated data. Login is only used in live mode.</p>
        <a href="/">Go to the dashboard →</a>
      </div>
    );
  }

  return (
    <form className="card" style={{ maxWidth: 420, margin: '40px auto' }} onSubmit={submit}>
      <h1 style={{ marginTop: 0 }}>Dashboard login</h1>
      <p className="muted small">
        This password only opens the dashboard. This app never asks for a private key or seed phrase. If anything does,
        it is a scam.
      </p>
      {meta && !meta.loginConfigured && (
        <div className="banner warn">Login is not configured on the server (ADMIN_PASSWORD_HASH / SESSION_SECRET).</div>
      )}
      <label htmlFor="pw">Password</label>
      <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={256} />
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      <p>
        <button className="primary" type="submit" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Log in'}
        </button>
      </p>
    </form>
  );
}
