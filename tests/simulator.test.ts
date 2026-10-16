import { describe, expect, it } from 'vitest';
import { SIGNALS } from '../src/domain/signals';
import { advance, applyScenario, createFleet } from '../src/sim/simulator';
import { MIN, T0, memoryStore } from './helpers';

const HOUR = 60 * MIN;

describe('simulator', () => {
  it('is deterministic for a seed', () => {
    const a = advance(createFleet(1, 50, T0), T0 + HOUR);
    const b = advance(createFleet(1, 50, T0), T0 + HOUR);
    expect(a).toEqual(b);
  });

  it('produces the required imperfections', () => {
    const state = createFleet(7, 200, T0, T0 + 3 * HOUR);
    const packets = advance(state, T0 + 3 * HOUR);
    const ids = packets.map((p) => `${p.vehicleId}#${p.seq}`);
    const dupes = ids.length - new Set(ids).size;
    expect(dupes).toBeGreaterThan(0);

    const partial = packets.filter((p) => Object.keys(p.signals).length < SIGNALS.length).length;
    expect(partial / packets.length).toBeGreaterThan(0.5);

    const late = packets.filter((p) => p.receivedTs - p.ts > MIN).length;
    expect(late).toBeGreaterThan(0);

    // out-of-order: per vehicle, arrival order differs from seq order somewhere
    const lastSeq = new Map<string, number>();
    let outOfOrder = 0;
    for (const p of packets) {
      if (p.seq < (lastSeq.get(p.vehicleId) ?? 0)) outOfOrder++;
      lastSeq.set(p.vehicleId, Math.max(p.seq, lastSeq.get(p.vehicleId) ?? 0));
    }
    expect(outOfOrder).toBeGreaterThan(0);

    // missing: some seq numbers never delivered (dropped)
    const seen = new Set(ids);
    let missing = 0;
    for (const v of state.vehicles) for (let i = 1; i <= v.seq; i++) if (!seen.has(`${v.id}#${i}`)) missing++;
    expect(missing).toBeGreaterThan(0);

    expect(state.vehicles.some((v) => v.link === 'dead')).toBe(true);
  });

  it('delivers a buffered backlog after a dead-zone', () => {
    const state = createFleet(3, 30, T0);
    state.network = { ...state.network, dropRate: 0, dupRate: 0, lateRate: 0, basementPerHour: 0 };
    for (const v of state.vehicles) v.dieAt = null;
    advance(state, T0 + 5 * MIN);
    const [id] = applyScenario(state, 'basement');
    const during = advance(state, T0 + 6 * MIN).filter((p) => p.vehicleId === id);
    expect(during).toHaveLength(0);
    applyScenario(state, 'flush');
    const after = advance(state, T0 + 6 * MIN + 30_000).filter((p) => p.vehicleId === id);
    expect(after.length).toBeGreaterThan(0);
  });

  it('state round-trips through JSON (resumable after reload)', () => {
    const s = createFleet(9, 20, T0);
    advance(s, T0 + 10 * MIN);
    const copy = JSON.parse(JSON.stringify(s));
    expect(advance(copy, T0 + 20 * MIN)).toEqual(advance(s, T0 + 20 * MIN));
  });

  it('end-to-end: ingesting a seeded fleet twice stores each logical packet once', () => {
    const state = createFleet(11, 40, T0, T0 + 2 * HOUR);
    const packets = advance(state, T0 + 2 * HOUR);
    const store = memoryStore(state.vehicles.map((v) => v.id));
    const first = store.ingest(packets);
    const unique = new Set(packets.map((p) => `${p.vehicleId}#${p.seq}`)).size;
    expect(first.inserted).toBe(unique);
    expect(store.ingest(packets).inserted).toBe(0);
    expect(store.stats().packets).toBe(unique);
  });
});
