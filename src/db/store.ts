import type { Database } from '@sqlite.org/sqlite-wasm';
import { attentionState } from '../domain/attention';
import {
  ALERT_SIGNAL,
  assessVehicle,
  evaluateConditions,
  freshnessOf,
  sevRank,
  triageRank,
} from '../domain/derive';
import { findGaps, type Interval } from '../domain/history';
import {
  GAP_AFTER_MS,
  LATE_AFTER_MS,
  MAX_FUTURE_SKEW_MS,
  SIGNAL_SPECS,
  SIGNALS,
  type Signal,
} from '../domain/signals';
import type {
  AlertAction,
  AlertEpisode,
  AlertKind,
  AttentionState,
  Freshness,
  LatestSignals,
  ReceivedPacket,
  Severity,
  SignalReading,
  VehicleStatus,
} from '../domain/types';
import { DDL, SCHEMA_VERSION } from './schema';

export interface VehicleMeta {
  id: string;
  name: string;
  depot: string;
  model: string;
}

export interface IngestResult {
  received: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  late: number;
  skewed: number;
  vehicles: string[];
}

export type SignalView = SignalReading & { freshness: Freshness };

export interface OpenAlertView {
  episodeId: number;
  kind: AlertKind;
  severity: Severity;
  value: number;
  valueTs: number;
  openedTs: number;
  attention: AttentionState;
  escalatedSinceAction: boolean;
}

export interface FleetRow extends VehicleMeta {
  status: VehicleStatus;
  reasons: string[];
  triage: number;
  staleBreach: boolean;
  lastContactTs: number | null;
  signals: Partial<Record<Signal, SignalView>>;
  alerts: OpenAlertView[];
  /** Most urgent attention state across open alerts, or null if none. */
  attention: AttentionState | null;
}

export interface AttentionItem extends OpenAlertView {
  vehicleId: string;
  vehicleName: string;
  depot: string;
  readingFreshness: Freshness;
  lastAction: Pick<AlertAction, 'id' | 'action' | 'createdTs' | 'untilTs'> | null;
}

export interface ClosedEpisodeView extends AlertEpisode {
  vehicleName: string;
}

export interface AlertEventView {
  id: number;
  episodeId: number;
  kind: AlertKind;
  ts: number;
  type: 'opened' | 'escalated' | 'deescalated' | 'recovered' | 'stale';
  severity: Severity | null;
  value: number | null;
}

export interface ActionView extends AlertAction {
  kind: AlertKind;
}

export interface HistorySeries {
  eventTs: number[];
  receivedTs: number[];
  values: Record<'soc' | 'battery_temp_c' | 'speed_kph', (number | null)[]>;
  gaps: Interval[];
  latePackets: number;
  packets: number;
}

export interface PacketRow {
  seq: number;
  eventTs: number;
  receivedTs: number;
  late: boolean;
  signals: Partial<Record<Signal, number>>;
}

export interface Stats {
  vehicles: number;
  packets: number;
  openAlerts: number;
  received: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  late: number;
  skewed: number;
  dbBytes: number;
  oldestEventTs: number | null;
  newestEventTs: number | null;
}

const ATTENTION_RANK: Record<AttentionState, number> = { needs_action: 2, snoozed: 1, acknowledged: 0 };

type Row = Record<string, unknown>;
const num = (v: unknown) => v as number;
const str = (v: unknown) => v as string;

export class FleetStore {
  constructor(readonly db: Database) {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(DDL);
    db.exec({ sql: 'INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)', bind: ['schema_version', String(SCHEMA_VERSION)] });
  }

  // ---------------------------------------------------------------- meta

  getMeta(key: string): string | null {
    const v = this.db.selectValue('SELECT value FROM meta WHERE key = ?', [key]);
    return v === undefined ? null : (v as string);
  }

  setMeta(key: string, value: string) {
    this.db.exec({ sql: 'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', bind: [key, value] });
  }

  private bump(key: string, by: number) {
    if (!by) return;
    this.db.exec({
      sql: `INSERT INTO meta(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER)`,
      bind: [key, String(by)],
    });
  }

  // ---------------------------------------------------------------- vehicles

  upsertVehicles(vs: VehicleMeta[]) {
    this.db.transaction((db) => {
      const st = db.prepare(
        'INSERT INTO vehicles(id, name, depot, model) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, depot = excluded.depot, model = excluded.model',
      );
      try {
        for (const v of vs) st.bind([v.id, v.name, v.depot, v.model]).stepReset();
      } finally {
        st.finalize();
      }
    });
  }

  vehicleCount(): number {
    return num(this.db.selectValue('SELECT count(*) FROM vehicles'));
  }

  // ---------------------------------------------------------------- ingest

  /**
   * Idempotent ingest. A packet's identity is (vehicle_id, seq); replaying the same
   * packets any number of times leaves the database unchanged apart from counters.
   * The whole batch is committed in one transaction.
   */
  ingest(packets: ReceivedPacket[]): IngestResult {
    const res: IngestResult = { received: packets.length, inserted: 0, duplicates: 0, conflicts: 0, late: 0, skewed: 0, vehicles: [] };
    if (!packets.length) return res;
    const touched = new Set<string>();
    const newest = new Map<string, { p: ReceivedPacket; s: Signal; v: number; ts: number; seq: number }>();
    this.db.transaction((db) => {
      const cols = SIGNALS.join(', ');
      const ins = db.prepare(
        `INSERT OR IGNORE INTO packets (vehicle_id, seq, event_ts, received_ts, ${cols})
         VALUES (?, ?, ?, ?, ${SIGNALS.map(() => '?').join(', ')})`,
      );
      const existing = db.prepare(`SELECT event_ts, ${cols} FROM packets WHERE vehicle_id = ? AND seq = ?`);
      const dup = db.prepare('UPDATE vehicles SET duplicates = duplicates + 1 WHERE id = ?');
      const up = db.prepare(
        `INSERT INTO latest_signal (vehicle_id, signal, value, event_ts, received_ts, seq) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(vehicle_id, signal) DO UPDATE SET
           value = excluded.value, event_ts = excluded.event_ts, received_ts = excluded.received_ts, seq = excluded.seq
         WHERE excluded.event_ts > latest_signal.event_ts
            OR (excluded.event_ts = latest_signal.event_ts AND excluded.seq > latest_signal.seq)`,
      );
      try {
        for (const p of packets) {
          const vals = SIGNALS.map((s) => p.signals[s] ?? null);
          ins.bind([p.vehicleId, p.seq, p.ts, p.receivedTs, ...vals]).stepReset();
          if (db.changes() === 0) {
            res.duplicates++;
            dup.bind([p.vehicleId]).stepReset();
            existing.bind([p.vehicleId, p.seq]);
            if (existing.step()) {
              const row = existing.get({}) as Row;
              const same = row.event_ts === p.ts && SIGNALS.every((s, i) => (row[s] ?? null) === vals[i]);
              if (!same) res.conflicts++;
            }
            existing.reset();
            continue;
          }
          res.inserted++;
          if (p.receivedTs - p.ts > LATE_AFTER_MS) res.late++;
          // Event times far in the future (vehicle clock skew) are kept in the log but
          // never become "latest", otherwise they would pin a reading as fresh forever.
          if (p.ts > p.receivedTs + MAX_FUTURE_SKEW_MS) {
            res.skewed++;
            continue;
          }
          touched.add(p.vehicleId);
          // Collapse the batch to the newest reading per (vehicle, signal) before upserting.
          for (const s of SIGNALS) {
            const v = p.signals[s];
            if (v === undefined || v === null) continue;
            const key = `${p.vehicleId}|${s}`;
            const cur = newest.get(key);
            if (!cur || p.ts > cur.ts || (p.ts === cur.ts && p.seq > cur.seq)) newest.set(key, { p, s, v, ts: p.ts, seq: p.seq });
          }
        }
        for (const { p, s, v } of newest.values()) up.bind([p.vehicleId, s, v, p.ts, p.receivedTs, p.seq]).stepReset();
      } finally {
        ins.finalize();
        existing.finalize();
        dup.finalize();
        up.finalize();
      }
      this.bump('stat.received', res.received);
      this.bump('stat.inserted', res.inserted);
      this.bump('stat.duplicates', res.duplicates);
      this.bump('stat.conflicts', res.conflicts);
      this.bump('stat.late', res.late);
      this.bump('stat.skewed', res.skewed);
    });
    res.vehicles = [...touched];
    return res;
  }

  /** Recomputes `latest_signal` from the raw log (used to verify the projection). */
  rebuildLatest() {
    this.db.transaction((db) => {
      db.exec('DELETE FROM latest_signal');
      for (const s of SIGNALS) {
        db.exec(`
          INSERT INTO latest_signal (vehicle_id, signal, value, event_ts, received_ts, seq)
          SELECT vehicle_id, '${s}', ${s}, event_ts, received_ts, seq FROM (
            SELECT vehicle_id, ${s}, event_ts, received_ts, seq,
                   row_number() OVER (PARTITION BY vehicle_id ORDER BY event_ts DESC, seq DESC) AS rn
            FROM packets WHERE ${s} IS NOT NULL AND event_ts <= received_ts + ${MAX_FUTURE_SKEW_MS}
          ) WHERE rn = 1`);
      }
    });
  }

  // ---------------------------------------------------------------- latest state

  loadLatest(vehicleIds?: string[]): Map<string, LatestSignals> {
    const rows = vehicleIds
      ? this.db.selectObjects(
          `SELECT * FROM latest_signal WHERE vehicle_id IN (${vehicleIds.map(() => '?').join(',')})`,
          vehicleIds,
        )
      : this.db.selectObjects('SELECT * FROM latest_signal');
    const out = new Map<string, LatestSignals>();
    for (const r of rows) {
      const id = str(r.vehicle_id);
      let m = out.get(id);
      if (!m) out.set(id, (m = {}));
      m[str(r.signal) as Signal] = { value: num(r.value), eventTs: num(r.event_ts), receivedTs: num(r.received_ts) };
    }
    return out;
  }

  // ---------------------------------------------------------------- alerts

  /**
   * Moves alert episodes forward to match what fresh readings say at `now`.
   * - fresh breach & no open episode  -> open
   * - fresh breach & severity changed -> escalate / de-escalate
   * - fresh, within limits            -> close as recovered
   * - stale or missing                -> close as stale (we can no longer claim it)
   * Returns the number of transitions written.
   */
  reconcileAlerts(now: number, vehicleIds?: string[]): number {
    let changes = 0;
    this.db.transaction((db) => {
      const latest = this.loadLatest(vehicleIds);
      const ids = vehicleIds ?? (db.selectValues('SELECT id FROM vehicles') as string[]);
      const openRows = db.selectObjects('SELECT * FROM alert_episodes WHERE closed_ts IS NULL');
      const open = new Map<string, AlertEpisode>();
      for (const r of openRows) {
        const ep = rowToEpisode(r);
        open.set(`${ep.vehicleId}|${ep.kind}`, ep);
      }
      const event = (episodeId: number, ts: number, type: string, severity: Severity | null, value: number | null) =>
        db.exec({ sql: 'INSERT INTO alert_events (episode_id, ts, type, severity, value) VALUES (?, ?, ?, ?, ?)', bind: [episodeId, ts, type, severity, value] });

      for (const id of ids) {
        for (const c of evaluateConditions(latest.get(id) ?? {}, now)) {
          const ep = open.get(`${id}|${c.kind}`);
          if (c.state === 'breach') {
            const { value, eventTs } = c.reading;
            if (!ep) {
              db.exec({
                sql: `INSERT INTO alert_episodes (vehicle_id, kind, severity, peak_severity, value, value_ts, opened_ts)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`,
                bind: [id, c.kind, c.severity, c.severity, value, eventTs, eventTs],
              });
              event(num(db.selectValue('SELECT last_insert_rowid()')), eventTs, 'opened', c.severity, value);
              changes++;
            } else if (ep.severity !== c.severity || ep.valueTs !== eventTs) {
              const peak = sevRank(c.severity) > sevRank(ep.peakSeverity) ? c.severity : ep.peakSeverity;
              db.exec({
                sql: 'UPDATE alert_episodes SET severity = ?, peak_severity = ?, value = ?, value_ts = ? WHERE id = ?',
                bind: [c.severity, peak, value, eventTs, ep.id],
              });
              if (ep.severity !== c.severity) {
                event(ep.id, eventTs, sevRank(c.severity) > sevRank(ep.severity) ? 'escalated' : 'deescalated', c.severity, value);
                changes++;
              }
            }
          } else if (ep) {
            const closedTs =
              c.state === 'clear'
                ? c.reading.eventTs
                : c.reading
                  ? c.reading.eventTs + SIGNAL_SPECS[ALERT_SIGNAL[c.kind]].staleAfterMs
                  : now;
            const reason = c.state === 'clear' ? 'recovered' : 'stale';
            db.exec({ sql: 'UPDATE alert_episodes SET closed_ts = ?, close_reason = ? WHERE id = ?', bind: [closedTs, reason, ep.id] });
            event(ep.id, closedTs, reason, null, c.reading?.value ?? null);
            changes++;
          }
        }
      }
    });
    return changes;
  }

  private actionsByEpisode(episodeIds: number[]): Map<number, AlertAction[]> {
    const out = new Map<number, AlertAction[]>();
    if (!episodeIds.length) return out;
    const rows = this.db.selectObjects(
      `SELECT * FROM alert_actions WHERE episode_id IN (${episodeIds.map(() => '?').join(',')}) ORDER BY created_ts`,
      episodeIds,
    );
    for (const r of rows) {
      const a = rowToAction(r);
      const list = out.get(a.episodeId) ?? [];
      list.push(a);
      out.set(a.episodeId, list);
    }
    return out;
  }

  private openAlertViews(now: number, vehicleId?: string): Map<string, OpenAlertView[]> {
    const rows = vehicleId
      ? this.db.selectObjects('SELECT * FROM alert_episodes WHERE closed_ts IS NULL AND vehicle_id = ?', [vehicleId])
      : this.db.selectObjects('SELECT * FROM alert_episodes WHERE closed_ts IS NULL');
    const eps = rows.map(rowToEpisode);
    const actions = this.actionsByEpisode(eps.map((e) => e.id));
    const out = new Map<string, OpenAlertView[]>();
    for (const ep of eps) {
      const att = attentionState(ep, actions.get(ep.id) ?? [], now);
      const list = out.get(ep.vehicleId) ?? [];
      list.push({
        episodeId: ep.id,
        kind: ep.kind,
        severity: ep.severity,
        value: ep.value,
        valueTs: ep.valueTs,
        openedTs: ep.openedTs,
        attention: att.state,
        escalatedSinceAction: att.escalatedSinceAction,
      });
      out.set(ep.vehicleId, list);
    }
    return out;
  }

  act(episodeId: number, action: 'ack' | 'snooze', now: number, untilTs: number | null = null): number {
    const ep = this.db.selectObject('SELECT * FROM alert_episodes WHERE id = ?', [episodeId]);
    if (!ep) throw new Error(`Unknown alert ${episodeId}`);
    if (ep.closed_ts !== null) throw new Error('This alert has already closed');
    if (action === 'snooze' && (untilTs === null || untilTs <= now)) throw new Error('Snooze needs a future time');
    this.db.exec({
      sql: `INSERT INTO alert_actions (episode_id, action, severity_at_action, until_ts, created_ts) VALUES (?, ?, ?, ?, ?)`,
      // Record the peak so an ack after an escalation covers that escalation.
      bind: [episodeId, action, str(ep.peak_severity), action === 'snooze' ? untilTs : null, now],
    });
    return num(this.db.selectValue('SELECT last_insert_rowid()'));
  }

  undoAction(actionId: number, now: number) {
    this.db.exec({ sql: 'UPDATE alert_actions SET undone_ts = ? WHERE id = ? AND undone_ts IS NULL', bind: [now, actionId] });
  }

  // ---------------------------------------------------------------- read models

  private toSignalViews(latest: LatestSignals, now: number): Partial<Record<Signal, SignalView>> {
    const out: Partial<Record<Signal, SignalView>> = {};
    for (const s of SIGNALS) {
      const r = latest[s];
      if (r) out[s] = { ...r, freshness: freshnessOf(s, r, now) };
    }
    return out;
  }

  private buildRow(meta: VehicleMeta, latest: LatestSignals, alerts: OpenAlertView[], now: number): FleetRow {
    const a = assessVehicle(latest, now);
    const attention = alerts.length
      ? alerts.map((x) => x.attention).sort((x, y) => ATTENTION_RANK[y] - ATTENTION_RANK[x])[0]!
      : null;
    return {
      ...meta,
      status: a.status,
      reasons: a.reasons,
      triage: triageRank(a),
      staleBreach: a.staleBreach,
      lastContactTs: a.lastContactTs,
      signals: this.toSignalViews(latest, now),
      alerts,
      attention,
    };
  }

  getFleet(now: number): FleetRow[] {
    const latest = this.loadLatest();
    const alerts = this.openAlertViews(now);
    const vehicles = this.db.selectObjects('SELECT id, name, depot, model FROM vehicles ORDER BY id') as unknown as VehicleMeta[];
    return vehicles.map((v) => this.buildRow(v, latest.get(v.id) ?? {}, alerts.get(v.id) ?? [], now));
  }

  getVehicle(id: string, now: number) {
    const meta = this.db.selectObject('SELECT id, name, depot, model, duplicates FROM vehicles WHERE id = ?', [id]);
    if (!meta) return null;
    const latest = this.loadLatest([id]).get(id) ?? {};
    const row = this.buildRow(meta as unknown as VehicleMeta, latest, this.openAlertViews(now, id).get(id) ?? [], now);
    const events = this.db
      .selectObjects(
        `SELECT e.*, ep.kind FROM alert_events e JOIN alert_episodes ep ON ep.id = e.episode_id
         WHERE ep.vehicle_id = ? ORDER BY e.ts DESC, e.id DESC LIMIT 50`,
        [id],
      )
      .map(
        (r): AlertEventView => ({
          id: num(r.id),
          episodeId: num(r.episode_id),
          kind: str(r.kind) as AlertKind,
          ts: num(r.ts),
          type: str(r.type) as AlertEventView['type'],
          severity: (r.severity as Severity | null) ?? null,
          value: (r.value as number | null) ?? null,
        }),
      );
    const actions = this.db
      .selectObjects(
        `SELECT a.*, ep.kind FROM alert_actions a JOIN alert_episodes ep ON ep.id = a.episode_id
         WHERE ep.vehicle_id = ? ORDER BY a.created_ts DESC LIMIT 50`,
        [id],
      )
      .map((r): ActionView => ({ ...rowToAction(r), kind: str(r.kind) as AlertKind }));
    return { ...row, duplicates: num(meta.duplicates), events, actions };
  }

  getHistory(id: string, from: number, now: number): HistorySeries {
    const rows = this.db.selectObjects(
      `SELECT event_ts, received_ts, soc, battery_temp_c, speed_kph FROM packets
       WHERE vehicle_id = ? AND event_ts >= ? ORDER BY event_ts, seq`,
      [id, from],
    );
    const eventTs = rows.map((r) => num(r.event_ts));
    const receivedTs = rows.map((r) => num(r.received_ts));
    return {
      eventTs,
      receivedTs,
      values: {
        soc: rows.map((r) => (r.soc as number | null) ?? null),
        battery_temp_c: rows.map((r) => (r.battery_temp_c as number | null) ?? null),
        speed_kph: rows.map((r) => (r.speed_kph as number | null) ?? null),
      },
      gaps: findGaps(eventTs, GAP_AFTER_MS, from, now),
      latePackets: rows.filter((r) => num(r.received_ts) - num(r.event_ts) > LATE_AFTER_MS).length,
      packets: rows.length,
    };
  }

  getRecentPackets(id: string, limit: number): PacketRow[] {
    return this.db
      .selectObjects(`SELECT * FROM packets WHERE vehicle_id = ? ORDER BY received_ts DESC, seq DESC LIMIT ?`, [id, limit])
      .map((r) => {
        const signals: Partial<Record<Signal, number>> = {};
        for (const s of SIGNALS) if (r[s] !== null && r[s] !== undefined) signals[s] = num(r[s]);
        return {
          seq: num(r.seq),
          eventTs: num(r.event_ts),
          receivedTs: num(r.received_ts),
          late: num(r.received_ts) - num(r.event_ts) > LATE_AFTER_MS,
          signals,
        };
      });
  }

  getAttention(now: number, closedWindowMs = 6 * 3600_000) {
    const vehicles = new Map(
      (this.db.selectObjects('SELECT id, name, depot FROM vehicles') as unknown as VehicleMeta[]).map((v) => [v.id, v]),
    );
    const latest = this.loadLatest();
    const open = this.openAlertViews(now);
    const lastActions = new Map<number, AttentionItem['lastAction']>();
    for (const r of this.db.selectObjects(
      `SELECT a.* FROM alert_actions a JOIN alert_episodes e ON e.id = a.episode_id
       WHERE e.closed_ts IS NULL AND a.undone_ts IS NULL ORDER BY a.created_ts`,
    )) {
      lastActions.set(num(r.episode_id), {
        id: num(r.id),
        action: str(r.action) as 'ack' | 'snooze',
        createdTs: num(r.created_ts),
        untilTs: (r.until_ts as number | null) ?? null,
      });
    }
    const items: AttentionItem[] = [];
    for (const [vid, list] of open) {
      const v = vehicles.get(vid)!;
      for (const a of list) {
        const sig = ALERT_SIGNAL[a.kind];
        items.push({
          ...a,
          vehicleId: vid,
          vehicleName: v.name,
          depot: v.depot,
          readingFreshness: freshnessOf(sig, latest.get(vid)?.[sig], now),
          lastAction: lastActions.get(a.episodeId) ?? null,
        });
      }
    }
    items.sort((x, y) => sevRank(y.severity) - sevRank(x.severity) || x.openedTs - y.openedTs);

    const closed = this.db
      .selectObjects(
        `SELECT e.*, v.name AS vehicle_name FROM alert_episodes e JOIN vehicles v ON v.id = e.vehicle_id
         WHERE e.closed_ts IS NOT NULL AND e.closed_ts >= ? ORDER BY e.closed_ts DESC LIMIT 200`,
        [now - closedWindowMs],
      )
      .map((r): ClosedEpisodeView => ({ ...rowToEpisode(r), vehicleName: str(r.vehicle_name) }));

    const unverified: { vehicleId: string; vehicleName: string; depot: string; kind: AlertKind; severity: Severity; value: number; eventTs: number }[] = [];
    for (const [vid, l] of latest) {
      for (const c of evaluateConditions(l, now)) {
        if (c.state === 'unknown' && c.lastKnownSeverity && c.reading) {
          const v = vehicles.get(vid)!;
          unverified.push({ vehicleId: vid, vehicleName: v.name, depot: v.depot, kind: c.kind, severity: c.lastKnownSeverity, value: c.reading.value, eventTs: c.reading.eventTs });
        }
      }
    }
    unverified.sort((a, b) => b.eventTs - a.eventTs);
    return { items, closed, unverified };
  }

  stats(): Stats {
    const m = new Map(
      this.db.selectObjects("SELECT key, value FROM meta WHERE key LIKE 'stat.%'").map((r) => [str(r.key).slice(5), Number(r.value)]),
    );
    const range = this.db.selectObject('SELECT min(event_ts) AS lo, max(event_ts) AS hi, count(*) AS n FROM packets')!;
    return {
      vehicles: this.vehicleCount(),
      packets: num(range.n),
      openAlerts: num(this.db.selectValue('SELECT count(*) FROM alert_episodes WHERE closed_ts IS NULL')),
      received: m.get('received') ?? 0,
      inserted: m.get('inserted') ?? 0,
      duplicates: m.get('duplicates') ?? 0,
      conflicts: m.get('conflicts') ?? 0,
      late: m.get('late') ?? 0,
      skewed: m.get('skewed') ?? 0,
      dbBytes: num(this.db.selectValue('SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()')),
      oldestEventTs: (range.lo as number | null) ?? null,
      newestEventTs: (range.hi as number | null) ?? null,
    };
  }

  /** Most recently received packets, for the "replay" demo (re-ingesting must be a no-op). */
  recentPackets(limit: number): ReceivedPacket[] {
    return this.db
      .selectObjects('SELECT * FROM packets ORDER BY received_ts DESC LIMIT ?', [limit])
      .map((r) => {
        const signals: Partial<Record<Signal, number>> = {};
        for (const s of SIGNALS) if (r[s] !== null && r[s] !== undefined) signals[s] = num(r[s]);
        return { vehicleId: str(r.vehicle_id), seq: num(r.seq), ts: num(r.event_ts), receivedTs: num(r.received_ts), signals };
      });
  }

  /** Drops raw packets older than `before`. Latest-state and alert history are kept. */
  prune(before: number): number {
    this.db.exec({ sql: 'DELETE FROM packets WHERE event_ts < ?', bind: [before] });
    return this.db.changes();
  }

  // ---------------------------------------------------------------- simulator state

  loadSimState<T>(): T | null {
    const v = this.db.selectValue('SELECT json FROM sim_state WHERE id = 1');
    return v === undefined ? null : (JSON.parse(v as string) as T);
  }

  saveSimState(state: unknown) {
    this.db.exec({
      sql: 'INSERT INTO sim_state (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
      bind: [JSON.stringify(state)],
    });
  }
}

function rowToEpisode(r: Row): AlertEpisode {
  return {
    id: num(r.id),
    vehicleId: str(r.vehicle_id),
    kind: str(r.kind) as AlertKind,
    severity: str(r.severity) as Severity,
    peakSeverity: str(r.peak_severity) as Severity,
    value: num(r.value),
    valueTs: num(r.value_ts),
    openedTs: num(r.opened_ts),
    closedTs: (r.closed_ts as number | null) ?? null,
    closeReason: (r.close_reason as AlertEpisode['closeReason']) ?? null,
  };
}

function rowToAction(r: Row): AlertAction {
  return {
    id: num(r.id),
    episodeId: num(r.episode_id),
    action: str(r.action) as AlertAction['action'],
    severityAtAction: str(r.severity_at_action) as Severity,
    untilTs: (r.until_ts as number | null) ?? null,
    createdTs: num(r.created_ts),
    undoneTs: (r.undone_ts as number | null) ?? null,
  };
}
