// ALERT ENGINE: a pure state machine. No network, no database, no clock of its own.
//
//   evaluate(previousState, reading, settings, now) -> { state, events, audit }
//
// Because it is pure, the caller can save the new state AND the events in one database
// transaction (Phase 4). After a restart the saved state is loaded, so alerts are not repeated.
//
// LEVELS: with thresholds [1.5, 1.25, 1.1]
//   level 0 = safe (HF ≥ 1.5, or no debt)
//   level 1 = HF < 1.5     (warning)
//   level 2 = HF < 1.25    (warning)
//   level 3 = HF < 1.1     (critical: the last threshold)
//
// RULES
//   - Going DOWN (worse): move to the new level at once and alert ONCE for that level,
//     even if several thresholds were skipped in one step.
//   - Going UP (better): only leave a level when HF ≥ threshold + hysteresis.
//     This stops the spam when HF wobbles around a threshold.
//   - Cooldown: a level that alerted recently stays silent if HF re-enters it soon after.
//   - Back to level 0: one "recovered" message, but only if the user was alerted in this episode.
//   - Critical: repeat every `criticalRepeatMs`, or sooner if HF keeps falling by `criticalWorsenDelta`.
//   - Reads failing for `dataProblemAfterMs`: one "monitoring degraded" message, then one
//     "monitoring restored" message when data is back. Thresholds are only evaluated on FRESH data.
//   - Paused: the state is still tracked, but events are suppressed (and logged in the audit).
import type { Address } from 'viem';
import type { NetworkKey } from '../chain/networks.js';
import type { PositionReadResult, PositionSnapshot } from '../core/types.js';
import type { AlertSettings } from './settings.js';

export interface AlertState {
  level: number;
  /** When the current level was entered. */
  levelSince: number | null;
  /** When the current "episode" (time away from level 0) started. */
  episodeStart: number | null;
  /** True once any alert was actually delivered during the current episode. */
  episodeNotified: boolean;
  /** Last time an alert was EMITTED for each level (for the cooldown). */
  lastAlertAtByLevel: Record<string, number>;
  lastCriticalNotifyAt: number | null;
  lastCriticalNotifyHf: number | null;
  criticalRepeatCount: number;
  dataProblemSince: number | null;
  dataProblemNotified: boolean;
  lastHealthFactor: number | null;
  lastEvaluatedAt: number | null;
}

export function initialAlertState(): AlertState {
  return {
    level: 0,
    levelSince: null,
    episodeStart: null,
    episodeNotified: false,
    lastAlertAtByLevel: {},
    lastCriticalNotifyAt: null,
    lastCriticalNotifyHf: null,
    criticalRepeatCount: 0,
    dataProblemSince: null,
    dataProblemNotified: false,
    lastHealthFactor: null,
    lastEvaluatedAt: null,
  };
}

export type AlertKind =
  | 'threshold-crossed'
  | 'critical-repeat'
  | 'recovered'
  | 'monitoring-degraded'
  | 'monitoring-restored';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertEvent {
  /** Deterministic id: the same state + reading always produce the same id (used for de-duplication). */
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  network: NetworkKey;
  wallet: Address;
  level: number;
  /** The threshold that was crossed (for threshold/critical events). */
  threshold: number | null;
  healthFactor: number | null;
  /** HF ≤ 1: the position can be liquidated now. */
  liquidatable: boolean;
  at: number;
  /** Why the event happened, in plain words (also stored in the audit log). */
  reason: string;
  snapshot: PositionSnapshot | null;
  /** Only for data-problem events. */
  dataError?: string;
}

export interface AuditEntry {
  at: number;
  eventId: string;
  kind: AlertKind;
  decision: 'emit' | 'suppress';
  reason: string;
}

export interface EvaluationResult {
  state: AlertState;
  events: AlertEvent[];
  audit: AuditEntry[];
}

/** Level for a health factor: how many thresholds it is below (thresholds sorted highest first). */
export function levelFor(hf: number | null, thresholds: number[], margin = 0): number {
  if (hf === null) return 0;
  return thresholds.filter((t) => hf < t + margin).length;
}

export function evaluate(
  previous: AlertState,
  reading: PositionReadResult,
  settings: AlertSettings,
  now: number,
): EvaluationResult {
  const s: AlertState = structuredClone(previous);
  const events: AlertEvent[] = [];
  const audit: AuditEntry[] = [];
  const th = settings.thresholds;
  const criticalLevel = th.length;
  const paused = settings.pausedUntil !== null && now < settings.pausedUntil;
  const posKey = `${reading.network}:${reading.wallet}`;
  const snapshot = reading.status === 'ok' ? reading.snapshot : null;
  const hf = snapshot?.healthFactor ?? null;

  const make = (kind: AlertKind, level: number, reason: string, extra: Partial<AlertEvent> = {}): AlertEvent => ({
    id: `${posKey}:${kind}:L${level}:${now}`,
    kind,
    severity:
      kind === 'recovered' || kind === 'monitoring-restored'
        ? 'info'
        : kind === 'monitoring-degraded'
          ? 'warning'
          : level === criticalLevel
            ? 'critical'
            : 'warning',
    network: reading.network,
    wallet: reading.wallet,
    level,
    threshold: level > 0 ? (th[level - 1] ?? null) : null,
    healthFactor: hf,
    liquidatable: hf !== null && hf <= 1,
    at: now,
    reason,
    snapshot,
    ...extra,
  });

  /** Emits the event unless alerts are paused. Returns true if it was emitted. */
  const emit = (ev: AlertEvent): boolean => {
    if (paused) {
      audit.push({ at: now, eventId: ev.id, kind: ev.kind, decision: 'suppress', reason: `paused until ${new Date(settings.pausedUntil!).toISOString()}` });
      return false;
    }
    events.push(ev);
    audit.push({ at: now, eventId: ev.id, kind: ev.kind, decision: 'emit', reason: ev.reason });
    return true;
  };
  const suppress = (ev: AlertEvent, reason: string) =>
    audit.push({ at: now, eventId: ev.id, kind: ev.kind, decision: 'suppress', reason });

  // --- 1. No fresh data: never evaluate thresholds on stale or missing data. ---------------
  if (!snapshot) {
    s.dataProblemSince ??= now;
    if (!s.dataProblemNotified && now - s.dataProblemSince >= settings.dataProblemAfterMs) {
      const minutes = Math.round((now - s.dataProblemSince) / 60_000);
      const ev = make('monitoring-degraded', s.level, `No fresh data for ${minutes} min (${reading.status}).`, {
        dataError: reading.error ?? reading.status,
      });
      // Marked as notified even when paused, so we do not send it late after the pause.
      s.dataProblemNotified = true;
      emit(ev);
    }
    return { state: s, events, audit };
  }

  // --- 2. Fresh data is back after a problem. -----------------------------------------------
  if (s.dataProblemSince !== null) {
    if (s.dataProblemNotified) emit(make('monitoring-restored', s.level, 'Fresh data is available again.'));
    s.dataProblemSince = null;
    s.dataProblemNotified = false;
  }

  // --- 3. Thresholds with hysteresis. ---------------------------------------------------------
  const prev = s.level;
  const raw = levelFor(hf, th);
  let next = prev;
  if (raw > prev) next = raw; // worse: move at once
  else if (raw < prev) next = Math.min(prev, levelFor(hf, th, settings.hysteresis)); // better: needs the margin

  if (next > prev) {
    if (prev === 0) {
      s.episodeStart = now;
      s.episodeNotified = false;
    }
    s.level = next;
    s.levelSince = now;
    const threshold = th[next - 1]!;
    const skipped = next - prev > 1 ? ` (skipped ${next - prev - 1} level${next - prev > 2 ? 's' : ''})` : '';
    const ev = make('threshold-crossed', next, `HF ${fmt(hf)} fell below ${threshold}${skipped}.`);
    const last = s.lastAlertAtByLevel[next];
    if (last !== undefined && now - last < settings.cooldownMs) {
      suppress(ev, `cooldown: level ${next} alerted ${Math.round((now - last) / 60_000)} min ago`);
    } else if (emit(ev)) {
      s.lastAlertAtByLevel[next] = now;
      s.episodeNotified = true;
      if (next === criticalLevel) {
        s.lastCriticalNotifyAt = now;
        s.lastCriticalNotifyHf = hf;
      }
    }
  } else if (next < prev) {
    s.level = next;
    s.levelSince = now;
    if (prev === criticalLevel) {
      s.lastCriticalNotifyAt = null;
      s.lastCriticalNotifyHf = null;
      s.criticalRepeatCount = 0;
    }
    if (next === 0) {
      const lowest = hf === null ? 'debt repaid' : `HF ${fmt(hf)} is back above ${round(th[0]! + settings.hysteresis)}`;
      const ev = make('recovered', 0, `Recovered: ${lowest}.`);
      if (s.episodeNotified) emit(ev);
      else suppress(ev, 'no alert was delivered in this episode');
      s.episodeStart = null;
      s.episodeNotified = false;
    }
  } else if (next === criticalLevel && criticalLevel > 0) {
    // --- 4. Still critical: repeat policy. ----------------------------------------------------
    const due = s.lastCriticalNotifyAt === null || now - s.lastCriticalNotifyAt >= settings.criticalRepeatMs;
    const worse = s.lastCriticalNotifyHf !== null && hf !== null && s.lastCriticalNotifyHf - hf >= settings.criticalWorsenDelta;
    if (due || worse) {
      const why = worse && !due ? `HF fell further to ${fmt(hf)}` : `still critical (HF ${fmt(hf)})`;
      const ev = make('critical-repeat', next, `Reminder: ${why}.`);
      if (emit(ev)) {
        s.lastCriticalNotifyAt = now;
        s.lastCriticalNotifyHf = hf;
        s.criticalRepeatCount += 1;
        s.episodeNotified = true;
      }
    }
  }

  s.lastHealthFactor = hf;
  s.lastEvaluatedAt = now;
  return { state: s, events, audit };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (hf: number | null) => (hf === null ? '∞' : hf.toFixed(3));
