import { describe, expect, it } from 'vitest';
import { evaluate, initialAlertState, levelFor, type AlertEvent, type AlertState, type AuditEntry } from '../src/alerts/engine.js';
import { formatAlert } from '../src/alerts/format.js';
import { DEFAULT_ALERT_SETTINGS, validateAlertSettings, type AlertSettings } from '../src/alerts/settings.js';
import type { PositionReadResult } from '../src/core/types.js';
import { DEMO_SCENARIOS, DRILL_CYCLE_MS, SimulatedDataSource, simulatePosition } from '../src/datasources/simulated.js';

const MIN = 60_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % DRILL_CYCLE_MS);
const steady = DEMO_SCENARIOS.find((s) => s.id === 'steady')!;
const baseSnapshot = simulatePosition(steady, T0);

type Step = number | null | 'error' | 'stale';

function reading(step: Step, t: number): PositionReadResult {
  const common = { network: steady.network, wallet: steady.wallet, fetchedAt: t };
  if (step === 'error') return { ...common, status: 'error', snapshot: null, error: 'RPC down' };
  if (step === 'stale') return { ...common, status: 'stale', staleReason: 'rpc-error', snapshot: { ...baseSnapshot, healthFactor: 0.5 }, error: 'RPC down' };
  return { ...common, status: 'ok', snapshot: { ...baseSnapshot, healthFactor: step, totalDebtUsd: step === null ? 0 : 6000 } };
}

/**
 * Feeds a sequence of HF values (one per `stepMs`) through the engine.
 * The state goes through JSON between steps, exactly like saving to and loading from a database.
 */
function run(steps: Step[], settings: Partial<AlertSettings> = {}, stepMs = MIN, start = T0) {
  const cfg = { ...DEFAULT_ALERT_SETTINGS, ...settings };
  let state: AlertState = initialAlertState();
  const events: AlertEvent[] = [];
  const audit: AuditEntry[] = [];
  steps.forEach((step, i) => {
    const t = start + i * stepMs;
    const r = evaluate(JSON.parse(JSON.stringify(state)) as AlertState, reading(step, t), cfg, t);
    state = r.state;
    events.push(...r.events);
    audit.push(...r.audit);
  });
  return { events, audit, state, kinds: events.map((e) => `${e.kind}:${e.level}`) };
}

describe('alert engine: levels and hysteresis', () => {
  it('maps HF to levels (thresholds 1.5 / 1.25 / 1.1)', () => {
    const th = [1.5, 1.25, 1.1];
    expect([2, 1.5, 1.49, 1.25, 1.2, 1.1, 1.05, null].map((hf) => levelFor(hf, th))).toEqual([0, 0, 1, 1, 2, 2, 3, 0]);
  });

  it('alerts ONCE per level on the way down', () => {
    expect(run([2, 1.45, 1.4, 1.2, 1.15]).kinds).toEqual(['threshold-crossed:1', 'threshold-crossed:2']);
  });

  it('skipping levels in one step gives one alert for the worst level, marked critical', () => {
    const { events } = run([1.6, 1.05]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'threshold-crossed', level: 3, severity: 'critical', threshold: 1.1 });
    expect(events[0]!.reason).toMatch(/skipped 2 levels/);
  });

  it('wobbling around a threshold (1.24 ↔ 1.27) produces exactly one alert', () => {
    const wobble = [1.3, 1.24, 1.27, 1.24, 1.28, 1.23, 1.29, 1.24];
    expect(run(wobble).kinds).toEqual(['threshold-crossed:1', 'threshold-crossed:2']);
  });

  it('leaves a level only when HF ≥ threshold + hysteresis', () => {
    // 1.2 → level 2. 1.29 is above 1.25 but below 1.30 → stays level 2. 1.31 → back to level 1.
    const { state: s1 } = run([1.2, 1.29]);
    expect(s1.level).toBe(2);
    const { state: s2 } = run([1.2, 1.31]);
    expect(s2.level).toBe(1);
  });

  it('sends one clear "recovered" message only above the first threshold + margin', () => {
    const { kinds, events } = run([1.4, 1.52, 1.54, 1.56]);
    expect(kinds).toEqual(['threshold-crossed:1', 'recovered:0']);
    expect(events[1]!.reason).toMatch(/back above 1.55/);
  });

  it('repaying all debt (HF = no debt) recovers immediately', () => {
    // 1.2 jumps straight to level 2 (one alert), then the debt is repaid in full.
    expect(run([1.2, null]).kinds).toEqual(['threshold-crossed:2', 'recovered:0']);
  });
});

describe('alert engine: cooldown and critical repeat', () => {
  it('cooldown: re-entering a level soon after its alert is silent (and logged)', () => {
    // Alert at 1.4, recover at 1.6, drop again 5 minutes later: inside the 30 min cooldown.
    const { kinds, audit } = run([1.4, 1.6, 1.4]);
    expect(kinds).toEqual(['threshold-crossed:1', 'recovered:0']);
    expect(audit.find((a) => a.decision === 'suppress')?.reason).toMatch(/cooldown/);
  });

  it('cooldown: alerts again once the cooldown has passed', () => {
    const { kinds } = run([1.4, 1.6, 1.4], { cooldownMs: 30 * MIN }, 20 * MIN);
    expect(kinds).toEqual(['threshold-crossed:1', 'recovered:0', 'threshold-crossed:1']);
  });

  it('no "recovered" message for an episode whose alert was suppressed', () => {
    const { kinds } = run([1.4, 1.6, 1.4, 1.6]);
    expect(kinds).toEqual(['threshold-crossed:1', 'recovered:0']); // not a second "recovered"
  });

  it('critical: repeats at the configured interval while HF stays critical', () => {
    const steps = Array<number>(61).fill(1.08); // 60 minutes at HF 1.08
    const { kinds, state } = run(steps, { criticalRepeatMs: 20 * MIN });
    expect(kinds).toEqual(['threshold-crossed:3', 'critical-repeat:3', 'critical-repeat:3', 'critical-repeat:3']);
    expect(state.criticalRepeatCount).toBe(3);
  });

  it('critical: repeats early when HF keeps falling by the worsen delta', () => {
    const { kinds } = run([1.09, 1.07, 1.05, 1.03], { criticalWorsenDelta: 0.04 });
    expect(kinds).toEqual(['threshold-crossed:3', 'critical-repeat:3']); // 1.09 → 1.05 is a 0.04 drop
  });

  it('flags HF ≤ 1 as liquidatable', () => {
    const { events } = run([0.98]);
    expect(events[0]!.liquidatable).toBe(true);
    expect(formatAlert(events[0]!)).toMatch(/can be liquidated NOW/);
  });
});

describe('alert engine: pause and data problems', () => {
  it('paused: tracks the level but suppresses alerts, with an audit reason', () => {
    const { events, audit, state } = run([1.4, 1.2], { pausedUntil: T0 + 10 * MIN });
    expect(events).toHaveLength(0);
    expect(state.level).toBe(2);
    expect(audit.every((a) => a.decision === 'suppress' && /paused/.test(a.reason))).toBe(true);
  });

  it('after a pause ends while critical, the reminder fires right away', () => {
    const { kinds } = run([1.05, 1.05, 1.05], { pausedUntil: T0 + 2 * MIN });
    expect(kinds).toEqual(['critical-repeat:3']);
  });

  it('never evaluates thresholds on stale data', () => {
    // The stale snapshot says HF 0.5, but stale data must not trigger threshold alerts.
    expect(run([2, 'stale', 'stale']).events).toHaveLength(0);
  });

  it('warns once when data is missing for too long, then once when it is back', () => {
    const steps: Step[] = [2, ...Array<Step>(20).fill('error'), 2, 2];
    const { kinds, events } = run(steps, { dataProblemAfterMs: 15 * MIN });
    expect(kinds).toEqual(['monitoring-degraded:0', 'monitoring-restored:0']);
    expect(events[0]!.dataError).toBe('RPC down');
    expect(formatAlert(events[0]!)).toMatch(/NOT being watched/);
  });

  it('a short data gap stays silent', () => {
    expect(run([2, 'error', 'error', 2]).events).toHaveLength(0);
  });
});

describe('alert engine: idempotency and restart', () => {
  it('evaluating the same reading from the same state gives the same event ids', () => {
    const a = evaluate(initialAlertState(), reading(1.2, T0), DEFAULT_ALERT_SETTINGS, T0);
    const b = evaluate(initialAlertState(), reading(1.2, T0), DEFAULT_ALERT_SETTINGS, T0);
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
  });

  it('after a "restart" (state reloaded from JSON) the same condition does not alert again', () => {
    const first = evaluate(initialAlertState(), reading(1.2, T0), DEFAULT_ALERT_SETTINGS, T0);
    const reloaded = JSON.parse(JSON.stringify(first.state)) as AlertState;
    const again = evaluate(reloaded, reading(1.2, T0 + MIN), DEFAULT_ALERT_SETTINGS, T0 + MIN);
    expect(first.events).toHaveLength(1);
    expect(again.events).toHaveLength(0);
  });
});

describe('REPLAY: simulated liquidation drill (falls to ~1.08, oscillates, recovers)', () => {
  async function replay(settings: Partial<AlertSettings>) {
    let now = T0;
    const source = new SimulatedDataSource({ now: () => now });
    const drill = DEMO_SCENARIOS.find((s) => s.id === 'liquidation-drill')!;
    const cfg = { ...DEFAULT_ALERT_SETTINGS, ...settings };
    let state = initialAlertState();
    const events: AlertEvent[] = [];
    let readings = 0;
    // One full 30-minute cycle, read every 15 seconds (much more often than a real poller).
    for (; now <= T0 + DRILL_CYCLE_MS; now += 15_000) {
      const [r] = await source.getPositions([{ network: drill.network, wallet: drill.wallet }]);
      const out = evaluate(state, r!, cfg, now);
      state = out.state;
      events.push(...out.events);
      readings++;
    }
    return { events, readings, kinds: events.map((e) => `${e.kind}:${e.level}`) };
  }

  it('with hysteresis + cooldown: exactly 3 warnings down and 1 recovery', async () => {
    const { kinds, readings } = await replay({});
    expect(readings).toBe(121);
    expect(kinds).toEqual(['threshold-crossed:1', 'threshold-crossed:2', 'threshold-crossed:3', 'recovered:0']);
  });

  it('a naive alerter (no hysteresis, no cooldown) would spam many more messages', async () => {
    const { events } = await replay({ hysteresis: 0, cooldownMs: 0 });
    console.log(`[replay] naive alerter: ${events.length} messages in one 30-minute cycle (engine: 4)`);
    expect(events.length).toBeGreaterThan(8);
  });
});

describe('settings validation', () => {
  it('normalizes thresholds: de-duplicated and sorted highest first', () => {
    const v = validateAlertSettings({ thresholds: [1.1, 1.5, 1.25, 1.5] });
    expect(v.ok && v.settings.thresholds).toEqual([1.5, 1.25, 1.1]);
  });

  it('rejects unsafe values', () => {
    const bad = validateAlertSettings({ thresholds: [0.9], hysteresis: 2, criticalRepeatMs: 1_000 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toHaveLength(3);
    expect(validateAlertSettings({ thresholds: [] }).ok).toBe(false);
    expect(validateAlertSettings({ thresholds: [1.5, 1.4, 1.3, 1.2, 1.15, 1.1] }).ok).toBe(false);
  });
});

describe('message formatting', () => {
  it('includes HF, network, amounts, a what-if estimate and the disclaimer', () => {
    const { events } = run([1.2]);
    const text = formatAlert(events[0]!);
    expect(text).toMatch(/health factor 1\.200 \(below 1\.25\)/);
    expect(text).toMatch(/Arbitrum · 0xDE30…0002/i);
    expect(text).toMatch(/Collateral \$/);
    expect(text).toMatch(/Estimate: a fall of about/);
    expect(text).toMatch(/Not financial advice/);
  });
});
