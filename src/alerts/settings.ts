// Alert settings per user, with validation (users can change them from the bot / dashboard).

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface AlertSettings {
  /** Health-factor thresholds, highest first, e.g. [1.5, 1.25, 1.1]. The last one is "critical". */
  thresholds: number[];
  /**
   * Hysteresis margin. To go back UP out of a level, HF must rise above threshold + margin.
   * Example: below 1.25 → only considered recovered from that level at 1.25 + 0.05 = 1.30.
   */
  hysteresis: number;
  /** After an alert for a level, the same level stays silent for this long. */
  cooldownMs: number;
  /** While critical, repeat the alert at this interval. */
  criticalRepeatMs: number;
  /** While critical, repeat early if HF falls by at least this much since the last critical alert. */
  criticalWorsenDelta: number;
  /** Warn the user that monitoring is blind after reads have failed for this long. */
  dataProblemAfterMs: number;
  /** Alerts are muted until this time (ms since epoch). null = not paused. */
  pausedUntil: number | null;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  thresholds: [1.5, 1.25, 1.1],
  hysteresis: 0.05,
  cooldownMs: 30 * MIN,
  criticalRepeatMs: 30 * MIN,
  criticalWorsenDelta: 0.05,
  dataProblemAfterMs: 15 * MIN,
  pausedUntil: null,
};

export const SETTINGS_LIMITS = {
  maxThresholds: 5,
  thresholdMin: 1.01,
  thresholdMax: 5,
  hysteresisMax: 0.5,
  cooldownMaxMs: 24 * HOUR,
  /** Never repeat critical alerts more often than every 5 minutes. */
  criticalRepeatMinMs: 5 * MIN,
  criticalRepeatMaxMs: 24 * HOUR,
  dataProblemMinMs: 1 * MIN,
  dataProblemMaxMs: 24 * HOUR,
} as const;

export type SettingsValidation = { ok: true; settings: AlertSettings } | { ok: false; errors: string[] };

/** Validates and normalizes settings (thresholds are de-duplicated and sorted highest first). */
export function validateAlertSettings(input: Partial<AlertSettings>, base: AlertSettings = DEFAULT_ALERT_SETTINGS): SettingsValidation {
  const s: AlertSettings = { ...base, ...input };
  const L = SETTINGS_LIMITS;
  const errors: string[] = [];
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

  if (!Array.isArray(s.thresholds) || s.thresholds.length === 0 || s.thresholds.length > L.maxThresholds) {
    errors.push(`Provide between 1 and ${L.maxThresholds} thresholds.`);
  } else if (!s.thresholds.every((t) => isNum(t) && t >= L.thresholdMin && t <= L.thresholdMax)) {
    errors.push(`Each threshold must be a number between ${L.thresholdMin} and ${L.thresholdMax}.`);
  } else {
    s.thresholds = [...new Set(s.thresholds.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => b - a);
  }
  if (!isNum(s.hysteresis) || s.hysteresis < 0 || s.hysteresis > L.hysteresisMax) {
    errors.push(`Hysteresis must be between 0 and ${L.hysteresisMax}.`);
  }
  if (!isNum(s.cooldownMs) || s.cooldownMs < 0 || s.cooldownMs > L.cooldownMaxMs) {
    errors.push('Cooldown must be between 0 and 24 hours.');
  }
  if (!isNum(s.criticalRepeatMs) || s.criticalRepeatMs < L.criticalRepeatMinMs || s.criticalRepeatMs > L.criticalRepeatMaxMs) {
    errors.push('Critical repeat interval must be between 5 minutes and 24 hours.');
  }
  if (!isNum(s.criticalWorsenDelta) || s.criticalWorsenDelta <= 0 || s.criticalWorsenDelta > 1) {
    errors.push('Critical worsen delta must be greater than 0 and at most 1.');
  }
  if (!isNum(s.dataProblemAfterMs) || s.dataProblemAfterMs < L.dataProblemMinMs || s.dataProblemAfterMs > L.dataProblemMaxMs) {
    errors.push('Data-problem delay must be between 1 minute and 24 hours.');
  }
  if (s.pausedUntil !== null && !isNum(s.pausedUntil)) errors.push('pausedUntil must be a timestamp or null.');

  return errors.length ? { ok: false, errors } : { ok: true, settings: s };
}
