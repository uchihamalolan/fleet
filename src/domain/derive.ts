import { OFFLINE_AFTER_MS, SIGNAL_SPECS, THRESHOLDS, type Signal } from './signals';
import type {
  AlertKind,
  Freshness,
  LatestSignals,
  Severity,
  SignalReading,
  VehicleStatus,
} from './types';

export function freshnessOf(signal: Signal, reading: SignalReading | undefined, now: number): Freshness {
  if (!reading) return 'missing';
  return now - reading.eventTs <= SIGNAL_SPECS[signal].staleAfterMs ? 'fresh' : 'stale';
}

/** Latest event time across all signals — "when did we last hear anything from it". */
export function lastContact(latest: LatestSignals): number | null {
  let max: number | null = null;
  for (const r of Object.values(latest)) {
    if (r && (max === null || r.eventTs > max)) max = r.eventTs;
  }
  return max;
}

export function socSeverity(soc: number): Severity | null {
  if (soc < THRESHOLDS.socCritical) return 'critical';
  if (soc < THRESHOLDS.socWarning) return 'warning';
  return null;
}

export function tempSeverity(tempC: number): Severity | null {
  return tempC > THRESHOLDS.tempCritical ? 'critical' : null;
}

export const ALERT_SIGNAL: Record<AlertKind, Signal> = {
  battery_soc: 'soc',
  battery_temp: 'battery_temp_c',
};

const SEVERITY_FN: Record<AlertKind, (v: number) => Severity | null> = {
  battery_soc: socSeverity,
  battery_temp: tempSeverity,
};

/**
 * Outcome of evaluating one alert condition at `now`.
 * - `breach`: a fresh reading crosses a threshold (the only state that may claim an alert)
 * - `clear`:  a fresh reading is within limits
 * - `unknown`: reading stale or missing; `lastKnown` says whether the last value breached
 */
export type ConditionResult =
  | { kind: AlertKind; state: 'breach'; severity: Severity; reading: SignalReading }
  | { kind: AlertKind; state: 'clear'; reading: SignalReading }
  | {
      kind: AlertKind;
      state: 'unknown';
      freshness: 'stale' | 'missing';
      reading?: SignalReading;
      lastKnownSeverity: Severity | null;
    };

export function evaluateCondition(kind: AlertKind, latest: LatestSignals, now: number): ConditionResult {
  const signal = ALERT_SIGNAL[kind];
  const reading = latest[signal];
  const f = freshnessOf(signal, reading, now);
  if (f === 'missing' || !reading) {
    return { kind, state: 'unknown', freshness: 'missing', lastKnownSeverity: null };
  }
  const severity = SEVERITY_FN[kind](reading.value);
  if (f === 'stale') {
    return { kind, state: 'unknown', freshness: 'stale', reading, lastKnownSeverity: severity };
  }
  return severity ? { kind, state: 'breach', severity, reading } : { kind, state: 'clear', reading };
}

export const ALERT_KINDS: AlertKind[] = ['battery_soc', 'battery_temp'];

export function evaluateConditions(latest: LatestSignals, now: number): ConditionResult[] {
  return ALERT_KINDS.map((k) => evaluateCondition(k, latest, now));
}

export interface VehicleAssessment {
  status: VehicleStatus;
  /** Human-readable reasons, most important first. Always text, never colour-only. */
  reasons: string[];
  conditions: ConditionResult[];
  lastContactTs: number | null;
  /** Last known (stale) reading breached a threshold — worth a look, but not a current claim. */
  staleBreach: boolean;
}

const KIND_LABEL: Record<AlertKind, string> = {
  battery_soc: 'Battery',
  battery_temp: 'Battery temp',
};

export function describeCondition(c: ConditionResult): string {
  const sig = ALERT_SIGNAL[c.kind];
  const unit = SIGNAL_SPECS[sig].unit;
  if (c.state === 'breach') {
    const v = `${c.reading.value.toFixed(SIGNAL_SPECS[sig].decimals)}${unit}`;
    if (c.kind === 'battery_soc') {
      return c.severity === 'critical' ? `Battery critically low (${v})` : `Low battery (${v})`;
    }
    return `Battery overheating (${v})`;
  }
  if (c.state === 'unknown') {
    if (c.freshness === 'missing') return `${KIND_LABEL[c.kind]}: never reported`;
    return c.lastKnownSeverity
      ? `${KIND_LABEL[c.kind]} reading stale (last known value was alerting)`
      : `${KIND_LABEL[c.kind]} reading stale`;
  }
  return `${KIND_LABEL[c.kind]} OK`;
}

/**
 * Deterministic status derivation from latest-known per-signal readings at `now`.
 * Precedence: offline > critical > warning > unverified > ok.
 * Offline wins because without any recent contact nothing about the vehicle is current.
 */
export function assessVehicle(latest: LatestSignals, now: number): VehicleAssessment {
  const conditions = evaluateConditions(latest, now);
  const lc = lastContact(latest);
  const staleBreach = conditions.some((c) => c.state === 'unknown' && c.lastKnownSeverity !== null);

  if (lc === null || now - lc > OFFLINE_AFTER_MS) {
    const reasons = [lc === null ? 'Never reported' : 'No telemetry for over 30 min'];
    if (staleBreach) reasons.push('Last report showed an alert condition');
    return { status: 'offline', reasons, conditions, lastContactTs: lc, staleBreach };
  }

  const breaches = conditions.filter((c) => c.state === 'breach');
  const unknowns = conditions.filter((c) => c.state === 'unknown');
  const reasons = [
    ...breaches.sort((a, b) => sevRank(b.severity) - sevRank(a.severity)).map(describeCondition),
    ...unknowns.map(describeCondition),
  ];

  let status: VehicleStatus = 'ok';
  if (breaches.some((c) => c.severity === 'critical')) status = 'critical';
  else if (breaches.length) status = 'warning';
  else if (unknowns.length) status = 'unverified';

  return { status, reasons, conditions, lastContactTs: lc, staleBreach };
}

export function sevRank(s: Severity | null | undefined): number {
  return s === 'critical' ? 2 : s === 'warning' ? 1 : 0;
}

export const STATUS_ORDER: VehicleStatus[] = ['critical', 'warning', 'unverified', 'offline', 'ok'];

export const STATUS_LABEL: Record<VehicleStatus, string> = {
  critical: 'Critical',
  warning: 'Warning',
  unverified: "Can't verify",
  offline: 'Offline',
  ok: 'Healthy',
};

/**
 * Triage ordering (lower = look first). Heuristic: active alerts first, then
 * vehicles whose last known state was alerting but can no longer be verified,
 * then other unverifiable/offline vehicles, then healthy ones.
 */
export function triageRank(a: VehicleAssessment): number {
  switch (a.status) {
    case 'critical':
      return 0;
    case 'warning':
      return 1;
    case 'unverified':
      return a.staleBreach ? 2 : 3;
    case 'offline':
      return a.staleBreach ? 2 : 4;
    case 'ok':
      return 5;
  }
}
