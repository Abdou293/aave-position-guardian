import type { Risk } from './api';

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdPrecise = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export const usd = (v: number | null | undefined, precise = false) =>
  v === null || v === undefined ? '—' : (precise ? usdPrecise : usdFmt).format(v);

export const hf = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v >= 100 ? '≥ 100' : v.toFixed(3));

export const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`);

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ago(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export const time = (at: number | null | undefined) =>
  at === null || at === undefined ? '—' : new Date(at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

export const RISK_LABEL: Record<Risk, string> = {
  safe: 'Safe',
  warning: 'Warning',
  critical: 'Critical',
  liquidatable: 'Liquidatable',
  'no-debt': 'No debt',
  unknown: 'No data',
};
