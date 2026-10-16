import { describe, expect, it } from 'vitest';
import { assessVehicle, evaluateCondition, freshnessOf, socSeverity, tempSeverity, triageRank } from '../src/domain/derive';
import { findGaps } from '../src/domain/history';
import type { LatestSignals } from '../src/domain/types';
import { MIN, T0 } from './helpers';

const r = (value: number, ageMin: number) => ({ value, eventTs: T0 - ageMin * MIN, receivedTs: T0 - ageMin * MIN });

describe('thresholds', () => {
  it('maps SOC to one escalating severity', () => {
    expect(socSeverity(25)).toBeNull();
    expect(socSeverity(20)).toBeNull(); // "below 20%" is strict
    expect(socSeverity(19.9)).toBe('warning');
    expect(socSeverity(10)).toBe('warning');
    expect(socSeverity(9.9)).toBe('critical');
  });
  it('flags battery temperature strictly above 45°C', () => {
    expect(tempSeverity(45)).toBeNull();
    expect(tempSeverity(45.1)).toBe('critical');
  });
});

describe('per-signal freshness', () => {
  it('is independent per signal', () => {
    const latest: LatestSignals = { speed_kph: r(50, 0), lat: r(12, 0), lng: r(77, 0), soc: r(15, 45) };
    expect(freshnessOf('speed_kph', latest.speed_kph, T0)).toBe('fresh');
    expect(freshnessOf('soc', latest.soc, T0)).toBe('stale');
    expect(freshnessOf('battery_temp_c', latest.battery_temp_c, T0)).toBe('missing');
  });

  it('never claims an alert from a stale reading, even if fresh location keeps arriving', () => {
    const latest: LatestSignals = { speed_kph: r(50, 0), soc: r(5, 30), battery_temp_c: r(30, 1) };
    const c = evaluateCondition('battery_soc', latest, T0);
    expect(c.state).toBe('unknown');
    expect(c.state === 'unknown' && c.lastKnownSeverity).toBe('critical');
    const a = assessVehicle(latest, T0);
    expect(a.status).toBe('unverified');
    expect(a.staleBreach).toBe(true);
  });
});

describe('assessVehicle', () => {
  it('is healthy when battery signals are fresh and within limits', () => {
    expect(assessVehicle({ soc: r(70, 1), battery_temp_c: r(30, 1) }, T0).status).toBe('ok');
  });
  it('picks the worst fresh breach', () => {
    const a = assessVehicle({ soc: r(15, 1), battery_temp_c: r(47, 1) }, T0);
    expect(a.status).toBe('critical');
    expect(a.reasons[0]).toMatch(/overheating/);
    expect(a.reasons[1]).toMatch(/Low battery/);
  });
  it('is offline when nothing has been heard for 30 minutes, regardless of last values', () => {
    const a = assessVehicle({ soc: r(5, 40), battery_temp_c: r(50, 40) }, T0);
    expect(a.status).toBe('offline');
    expect(a.staleBreach).toBe(true);
    expect(triageRank(a)).toBeLessThan(triageRank(assessVehicle({ soc: r(50, 40) }, T0)));
  });
  it('is offline when it never reported', () => {
    expect(assessVehicle({}, T0).status).toBe('offline');
  });
});

describe('findGaps', () => {
  it('reports interior and ongoing gaps', () => {
    const ts = [0, 1, 2, 10, 11].map((m) => T0 + m * MIN);
    const gaps = findGaps(ts, 5 * MIN, T0, T0 + 20 * MIN);
    expect(gaps).toEqual([
      { from: T0 + 2 * MIN, to: T0 + 10 * MIN },
      { from: T0 + 11 * MIN, to: T0 + 20 * MIN, ongoing: true },
    ]);
  });
});
