'use client';
// Typed access to the backend API (through the /api proxy) + a small polling hook.
import { useCallback, useEffect, useRef, useState } from 'react';

export type Risk = 'safe' | 'warning' | 'critical' | 'liquidatable' | 'no-debt' | 'unknown';
export type ReadStatus = 'ok' | 'stale' | 'error' | 'none';

export interface Meta {
  mode: 'demo' | 'live';
  readOnly: true;
  authRequired: boolean;
  loginConfigured: boolean;
  authenticated: boolean;
  networks: Array<{ key: string; name: string }>;
  pollIntervalMs: number;
  disclaimer: string;
  whatIf: { formula: string; assumptions: string[] };
}

export interface PositionSummary {
  network: string;
  networkName: string;
  address: string;
  labels: string[];
  watchers?: number;
  status: ReadStatus;
  readAt: number | null;
  error: string | null;
  dataAt: number | null;
  dataAgeMs: number | null;
  hasDebt: boolean | null;
  healthFactor: number | null;
  risk: Risk;
  totalCollateralUsd: number | null;
  totalDebtUsd: number | null;
  source: 'onchain' | 'simulated' | null;
  whatIfDropFraction: number | null;
  whatIfAsset: string | null;
}

export interface AssetPosition {
  asset: string;
  symbol: string;
  amount: number;
  valueUsd: number;
  priceUsd: number;
}

export interface Snapshot {
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  liquidationThreshold: number;
  ltv: number;
  healthFactor: number | null;
  eModeCategory: number;
  collateral: AssetPosition[];
  debts: AssetPosition[];
  assetBreakdownAvailable: boolean;
  blockNumber: number | null;
}

export type WhatIf =
  | { kind: 'no-debt' | 'unavailable'; message: string }
  | { kind: 'at-or-below-1'; healthFactor: number; message: string }
  | { kind: 'not-reachable'; asset: string; share: number; message: string; formula: string; assumptions: string[] }
  | {
      kind: 'estimate';
      asset: string;
      dropFraction: number;
      currentPriceUsd: number;
      estimatedLiquidationPriceUsd: number;
      share: number;
      healthFactor: number;
      assetAlsoBorrowed: boolean;
      message: string;
      formula: string;
      assumptions: string[];
    };

export interface PositionDetail extends PositionSummary {
  snapshot: Snapshot | null;
  whatIf: WhatIf | null;
  thresholds: number[];
  history: Array<{ at: number; healthFactor: number | null; ok: boolean }>;
  historyHours: number;
}

export interface AlertItem {
  id: string;
  network: string;
  address: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  healthFactor: number | null;
  message: string;
  createdAt: number;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain';
  attempts: number;
  sentAt: number | null;
  lastError: string | null;
}

export interface AuditItem {
  at: number;
  network: string | null;
  address: string | null;
  kind: string;
  decision: 'emit' | 'suppress';
  reason: string;
}

export interface NetworkItem {
  network: string;
  name: string;
  source: 'simulated' | 'custom' | 'public';
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastBlockNumber: number | null;
}

export interface NetworksResponse {
  at: number;
  pollIntervalMs: number;
  monitor: { lastCycleAt: number | null; lastCycleError: string | null };
  networks: NetworkItem[];
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw new ApiError('The backend is not reachable. A free host may be waking up; retrying…', 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return body as T;
}

export async function apiPost<T>(path: string, data: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return body as T;
}

/** Fetches `path` now and every `intervalMs`. A 401 sends the user to the login page. */
export function usePolling<T>(path: string | null, intervalMs = 15_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    try {
      const d = await apiGet<T>(p);
      if (pathRef.current !== p) return;
      setData(d);
      setError(null);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('Unexpected error', 0);
      if (err.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return;
      }
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load();
    const t = setInterval(() => void load(), intervalMs);
    return () => clearInterval(t);
  }, [path, intervalMs, load]);

  return { data, error, loading, reload: load };
}
