import { describe, expect, it } from 'vitest';
import { MIN, T0, memoryStore, pkt } from './helpers';

describe('ingest: identity and deduplication', () => {
  it('ignores exact duplicates and replays', () => {
    const s = memoryStore();
    const batch = [pkt('TRK-001', 1, T0, { soc: 50 }), pkt('TRK-001', 2, T0 + MIN, { soc: 49 })];
    expect(s.ingest(batch).inserted).toBe(2);
    const replay = s.ingest([...batch, ...batch]);
    expect(replay).toMatchObject({ inserted: 0, duplicates: 4, conflicts: 0 });
    expect(s.stats().packets).toBe(2);
  });

  it('treats the same id with different content as a conflict; first write wins', () => {
    const s = memoryStore();
    s.ingest([pkt('TRK-001', 1, T0, { soc: 50 })]);
    const r = s.ingest([pkt('TRK-001', 1, T0, { soc: 10 })]);
    expect(r).toMatchObject({ inserted: 0, duplicates: 1, conflicts: 1 });
    expect(s.loadLatest().get('TRK-001')!.soc!.value).toBe(50);
  });

  it('scopes sequence numbers per vehicle', () => {
    const s = memoryStore();
    expect(s.ingest([pkt('TRK-001', 1, T0, { soc: 50 }), pkt('TRK-002', 1, T0, { soc: 60 })]).inserted).toBe(2);
  });
});

describe('ingest: latest state by event time', () => {
  it('out-of-order and late packets never overwrite newer readings', () => {
    const s = memoryStore();
    s.ingest([pkt('TRK-001', 3, T0 + 2 * MIN, { soc: 40 })]);
    s.ingest([pkt('TRK-001', 1, T0, { soc: 60, battery_temp_c: 30 }, T0 + 5 * MIN)]);
    const l = s.loadLatest().get('TRK-001')!;
    expect(l.soc!.value).toBe(40);
    // A partial packet only advances the signals it carries.
    expect(l.battery_temp_c).toMatchObject({ value: 30, eventTs: T0 });
  });

  it('backfilled backlog advances latest only where it is newer', () => {
    const s = memoryStore();
    s.ingest([pkt('TRK-001', 1, T0, { soc: 80, speed_kph: 10 })]);
    // backlog of 30 packets produced underground, uploaded together much later
    const backlog = Array.from({ length: 30 }, (_, i) => pkt('TRK-001', 2 + i, T0 + (i + 1) * MIN, { speed_kph: i }, T0 + 40 * MIN));
    const r = s.ingest(backlog.reverse());
    expect(r.late).toBe(30);
    const l = s.loadLatest().get('TRK-001')!;
    expect(l.speed_kph).toMatchObject({ value: 29, eventTs: T0 + 30 * MIN });
    expect(l.soc).toMatchObject({ value: 80, eventTs: T0 });
  });

  it('latest projection equals a full rebuild from the log', () => {
    const s = memoryStore();
    const ps = [];
    for (let i = 1; i <= 50; i++) {
      const ts = T0 + ((i * 7919) % 50) * MIN; // scrambled order
      ps.push(pkt(i % 2 ? 'TRK-001' : 'TRK-002', i, ts, i % 3 ? { soc: i } : { battery_temp_c: i }));
    }
    s.ingest(ps);
    const before = s.loadLatest();
    s.rebuildLatest();
    expect(s.loadLatest()).toEqual(before);
  });

  it('keeps clock-skewed packets in the log but out of latest state', () => {
    const s = memoryStore();
    const r = s.ingest([pkt('TRK-001', 1, T0 + 60 * MIN, { soc: 5 }, T0)]);
    expect(r.skewed).toBe(1);
    expect(s.loadLatest().get('TRK-001')).toBeUndefined();
  });
});

describe('alert episodes', () => {
  it('opens, escalates, de-escalates and recovers from fresh readings', () => {
    const s = memoryStore(['TRK-001']);
    const at = (seq: number, m: number, soc: number) => {
      s.ingest([pkt('TRK-001', seq, T0 + m * MIN, { soc })]);
      s.reconcileAlerts(T0 + m * MIN);
      return s.getFleet(T0 + m * MIN)[0]!;
    };
    expect(at(1, 0, 18).alerts[0]).toMatchObject({ severity: 'warning' });
    expect(at(2, 1, 9).alerts[0]).toMatchObject({ severity: 'critical' });
    expect(at(3, 2, 15).alerts[0]).toMatchObject({ severity: 'warning' });
    const row = at(4, 3, 30);
    expect(row.alerts).toHaveLength(0);
    const v = s.getVehicle('TRK-001', T0 + 3 * MIN)!;
    expect(v.events.map((e) => e.type).reverse()).toEqual(['opened', 'escalated', 'deescalated', 'recovered']);
    // one escalating battery alert, not two
    expect(new Set(v.events.map((e) => e.episodeId)).size).toBe(1);
  });

  it('closes an alert when its reading goes stale, without a new reading', () => {
    const s = memoryStore(['TRK-001']);
    s.ingest([pkt('TRK-001', 1, T0, { soc: 5 })]);
    s.reconcileAlerts(T0);
    s.ingest([pkt('TRK-001', 2, T0 + 15 * MIN, { speed_kph: 40 })]); // vehicle still talking
    s.reconcileAlerts(T0 + 15 * MIN);
    const row = s.getFleet(T0 + 15 * MIN)[0]!;
    expect(row.alerts).toHaveLength(0);
    expect(row.status).toBe('unverified');
    expect(row.staleBreach).toBe(true);
    const closed = s.getAttention(T0 + 15 * MIN).closed[0]!;
    expect(closed).toMatchObject({ closeReason: 'stale', closedTs: T0 + 10 * MIN });
  });

  it('a late backlog of old breaching readings does not raise an alert', () => {
    const s = memoryStore(['TRK-001']);
    const backlog = Array.from({ length: 10 }, (_, i) => pkt('TRK-001', i + 1, T0 + i * MIN, { soc: 5 }, T0 + 60 * MIN));
    s.ingest(backlog);
    s.reconcileAlerts(T0 + 60 * MIN);
    expect(s.getFleet(T0 + 60 * MIN)[0]!.alerts).toHaveLength(0);
  });

  it('ack survives de-escalation, is re-raised by escalation, and can be undone', () => {
    const s = memoryStore(['TRK-001']);
    s.ingest([pkt('TRK-001', 1, T0, { soc: 15 })]);
    s.reconcileAlerts(T0);
    const ep = s.getFleet(T0)[0]!.alerts[0]!.episodeId;
    const ackId = s.act(ep, 'ack', T0);
    expect(s.getFleet(T0)[0]!.attention).toBe('acknowledged');

    s.ingest([pkt('TRK-001', 2, T0 + MIN, { soc: 8 })]);
    s.reconcileAlerts(T0 + MIN);
    expect(s.getFleet(T0 + MIN)[0]!.alerts[0]).toMatchObject({ attention: 'needs_action', escalatedSinceAction: true });

    s.act(ep, 'ack', T0 + 2 * MIN);
    s.ingest([pkt('TRK-001', 3, T0 + 3 * MIN, { soc: 12 })]);
    s.reconcileAlerts(T0 + 3 * MIN);
    expect(s.getFleet(T0 + 3 * MIN)[0]!.attention).toBe('acknowledged');

    // undo the second ack -> first ack (at warning) no longer covers the critical peak
    const second = s.getVehicle('TRK-001', T0 + 3 * MIN)!.actions[0]!.id;
    s.undoAction(second, T0 + 4 * MIN);
    expect(s.getFleet(T0 + 4 * MIN)[0]!.attention).toBe('needs_action');
    expect(ackId).not.toBe(second);
  });

  it('refuses actions on closed alerts', () => {
    const s = memoryStore(['TRK-001']);
    s.ingest([pkt('TRK-001', 1, T0, { soc: 15 })]);
    s.reconcileAlerts(T0);
    const ep = s.getFleet(T0)[0]!.alerts[0]!.episodeId;
    s.ingest([pkt('TRK-001', 2, T0 + MIN, { soc: 50 })]);
    s.reconcileAlerts(T0 + MIN);
    expect(() => s.act(ep, 'ack', T0 + MIN)).toThrow(/closed/);
  });
});

describe('history', () => {
  it('reports gaps that late packets later fill', () => {
    const s = memoryStore(['TRK-001']);
    s.ingest([pkt('TRK-001', 1, T0, { soc: 50 }), pkt('TRK-001', 10, T0 + 20 * MIN, { soc: 45 })]);
    expect(s.getHistory('TRK-001', T0, T0 + 21 * MIN).gaps).toHaveLength(1);
    s.ingest(Array.from({ length: 8 }, (_, i) => pkt('TRK-001', 2 + i, T0 + (i + 1) * 2 * MIN, { soc: 49 }, T0 + 25 * MIN)));
    const h = s.getHistory('TRK-001', T0, T0 + 21 * MIN);
    expect(h.gaps).toHaveLength(0);
    expect(h.latePackets).toBe(8);
  });
});
