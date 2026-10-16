import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useHistory, useNow, useRecentPackets, useVehicle } from '../../client/hooks';
import { describeCondition } from '../../domain/derive';
import { LATE_AFTER_MS, SIGNAL_SPECS, SIGNALS, THRESHOLDS, type Signal } from '../../domain/signals';
import type { ActionView, AlertEventView } from '../../db/store';
import { AlertButtons } from '../components/AlertButtons';
import { AttentionTag, FreshnessTag, Reading, SeverityTag, StatusBadge } from '../components/Badges';
import { LineChart } from '../components/LineChart';
import { ago, clock, duration, fmtSignal } from '../format';

const WINDOWS = [
  { ms: 3600_000, label: '1 h' },
  { ms: 4 * 3600_000, label: '4 h' },
  { ms: 24 * 3600_000, label: '24 h' },
];

const DISPLAY_SIGNALS: Signal[] = ['soc', 'battery_temp_c', 'range_km', 'speed_kph', 'ignition', 'odometer_km', 'lat'];

export function VehiclePage() {
  const { id = '' } = useParams();
  const now = useNow();
  const { data, isLoading } = useVehicle(id);
  const [windowMs, setWindowMs] = useState(4 * 3600_000);

  if (isLoading) return <p className="muted">Loading…</p>;
  const v = data?.vehicle;
  if (!v) return <p>Unknown vehicle {id}. <Link to="/">Back to fleet</Link></p>;

  return (
    <div className="page vehicle-page">
      <nav className="crumbs">
        <Link to="/">← Fleet</Link>
      </nav>
      <header className="vehicle-head">
        <div>
          <h1>{v.name}</h1>
          <p className="muted">
            {v.model} · {v.depot} · last heard {ago(v.lastContactTs, now)}
          </p>
        </div>
        <StatusBadge status={v.status} />
      </header>

      <section className="panel">
        <h2>Current assessment</h2>
        {v.reasons.length ? (
          <ul className="reasons">
            {v.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          <p>Battery charge and temperature are fresh and within limits.</p>
        )}
        {v.alerts.map((a) => (
          <div key={a.episodeId} className="alert-line">
            <SeverityTag severity={a.severity} />
            <span>
              {describeCondition({ kind: a.kind, state: 'breach', severity: a.severity, reading: { value: a.value, eventTs: a.valueTs, receivedTs: a.valueTs } })}
              <small className="muted"> · open since {clock(a.openedTs)}</small>
            </span>
            <AttentionTag state={a.attention} escalated={a.escalatedSinceAction} />
            <AlertButtons
              episodeId={a.episodeId}
              vehicleName={v.name}
              kind={a.kind}
              state={a.attention}
              lastActionId={v.actions.find((x) => x.episodeId === a.episodeId && x.undoneTs === null)?.id}
            />
          </div>
        ))}
      </section>

      <section className="panel">
        <h2>Latest known readings</h2>
        <p className="muted small">Each signal ages independently. Stale readings are shown for context but never drive alerts.</p>
        <div className="signal-grid">
          {DISPLAY_SIGNALS.map((s) => {
            const r = v.signals[s];
            const isLoc = s === 'lat';
            return (
              <div key={s} className={`signal-card reading-${r?.freshness ?? 'missing'}`}>
                <div className="signal-label">{isLoc ? 'Location' : SIGNAL_SPECS[s].label}</div>
                {isLoc ? (
                  <div className="reading">
                    <span className="value">{r ? `${fmtSignal('lat', r.value)}, ${fmtSignal('lng', v.signals.lng?.value)}` : '—'}</span>
                  </div>
                ) : (
                  <Reading signal={s} view={r} now={now} />
                )}
                {isLoc && r && <FreshnessTag freshness={r.freshness} ts={r.eventTs} now={now} />}
                {r && (
                  <div className="small muted">
                    event {clock(r.eventTs)} · received {clock(r.receivedTs)}
                    {r.receivedTs - r.eventTs > LATE_AFTER_MS && <span className="tag late"> arrived {duration(r.receivedTs - r.eventTs)} late</span>}
                  </div>
                )}
                <div className="small muted">trusted for {duration(SIGNAL_SPECS[s].staleAfterMs)}</div>
              </div>
            );
          })}
        </div>
      </section>

      <History id={v.id} windowMs={windowMs} setWindowMs={setWindowMs} duplicates={v.duplicates} />

      <section className="panel">
        <h2>Alert & action timeline</h2>
        <Timeline events={v.events} actions={v.actions} />
      </section>

      <RecentPackets id={v.id} />
    </div>
  );
}

function History({ id, windowMs, setWindowMs, duplicates }: { id: string; windowMs: number; setWindowMs: (n: number) => void; duplicates: number }) {
  const { data } = useHistory(id, windowMs);
  if (!data) return null;
  const { history: h, now } = data;
  const from = now - windowMs;
  const missingMs = h.gaps.reduce((acc, g) => acc + (g.to - g.from), 0);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>History</h2>
        <div className="btn-row" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button key={w.ms} className={`btn ${w.ms === windowMs ? 'primary' : ''}`} aria-pressed={w.ms === windowMs} onClick={() => setWindowMs(w.ms)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <dl className="quality">
        <div>
          <dt>Packets stored</dt>
          <dd>{h.packets}</dd>
        </div>
        <div>
          <dt>Missing intervals</dt>
          <dd>
            {h.gaps.length} ({duration(missingMs)})
          </dd>
        </div>
        <div>
          <dt>Arrived late (&gt;1 min)</dt>
          <dd>{h.latePackets}</dd>
        </div>
        <div>
          <dt>Duplicates rejected (all time)</dt>
          <dd>{duplicates}</dd>
        </div>
      </dl>
      <LineChart
        label="State of charge (%)"
        unit="%"
        ts={h.eventTs}
        values={h.values.soc}
        from={from}
        to={now}
        gaps={h.gaps}
        yMin={0}
        yMax={100}
        thresholds={[
          { value: THRESHOLDS.socWarning, label: 'warning < 20%' },
          { value: THRESHOLDS.socCritical, label: 'critical < 10%' },
        ]}
      />
      <LineChart
        label="Battery temperature (°C)"
        unit="°C"
        ts={h.eventTs}
        values={h.values.battery_temp_c}
        from={from}
        to={now}
        gaps={h.gaps}
        thresholds={[{ value: THRESHOLDS.tempCritical, label: 'critical > 45°C' }]}
      />
      <LineChart label="Speed (km/h)" unit=" km/h" ts={h.eventTs} values={h.values.speed_kph} from={from} to={now} gaps={h.gaps} yMin={0} height={100} />
      <p className="small muted">Hatched areas: no packet for 5+ minutes (by event time). They fill in if a delayed backlog arrives.</p>
      {h.gaps.length > 0 && (
        <details>
          <summary>Missing intervals</summary>
          <ul className="small">
            {h.gaps.map((g) => (
              <li key={g.from}>
                {clock(g.from)} → {g.ongoing ? 'now' : clock(g.to)} ({duration(g.to - g.from)}){g.ongoing ? ' — still silent' : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const EVENT_TEXT: Record<AlertEventView['type'], string> = {
  opened: 'Alert opened',
  escalated: 'Escalated',
  deescalated: 'De-escalated',
  recovered: 'Recovered (fresh reading within limits)',
  stale: 'Closed — reading went stale, condition can no longer be confirmed',
};
const KIND = { battery_soc: 'Battery charge', battery_temp: 'Battery temp' } as const;

function Timeline({ events, actions }: { events: AlertEventView[]; actions: ActionView[] }) {
  const items = [
    ...events.map((e) => ({ ts: e.ts, key: `e${e.id}`, node: <EventLine e={e} /> })),
    ...actions.map((a) => ({
      ts: a.createdTs,
      key: `a${a.id}`,
      node: (
        <span className={a.undoneTs ? 'undone' : ''}>
          Operator {a.action === 'ack' ? 'acknowledged' : `snoozed until ${clock(a.untilTs)}`} {KIND[a.kind].toLowerCase()} alert
          {a.undoneTs ? ` (undone at ${clock(a.undoneTs)})` : ''}
        </span>
      ),
    })),
  ].sort((a, b) => b.ts - a.ts);
  if (!items.length) return <p className="muted">No alerts recorded for this vehicle.</p>;
  return (
    <ol className="timeline">
      {items.map((i) => (
        <li key={i.key}>
          <time>{clock(i.ts)}</time> {i.node}
        </li>
      ))}
    </ol>
  );
}

function EventLine({ e }: { e: AlertEventView }) {
  const unit = e.kind === 'battery_soc' ? '%' : '°C';
  return (
    <span>
      {KIND[e.kind]}: {EVENT_TEXT[e.type]}
      {e.severity && <> → {e.severity}</>}
      {e.value !== null && (
        <>
          {' '}
          ({e.value}
          {unit})
        </>
      )}
    </span>
  );
}

function RecentPackets({ id }: { id: string }) {
  const { data } = useRecentPackets(id);
  return (
    <section className="panel">
      <h2>Recently received packets</h2>
      <p className="small muted">Newest by receipt time. Packets carry only some signals; event time is when the truck produced it.</p>
      <div className="packet-table-wrap">
        <table className="packet-table">
          <thead>
            <tr>
              <th>Seq</th>
              <th>Event time</th>
              <th>Received</th>
              <th>Delay</th>
              <th>Signals</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.seq}>
                <td>#{p.seq}</td>
                <td>{clock(p.eventTs)}</td>
                <td>{clock(p.receivedTs)}</td>
                <td>{p.late ? <span className="tag late">late · {duration(p.receivedTs - p.eventTs)}</span> : `${((p.receivedTs - p.eventTs) / 1000).toFixed(1)}s`}</td>
                <td className="small">
                  {SIGNALS.filter((s) => s in p.signals && s !== 'lng')
                    .map((s) => (s === 'lat' ? 'location' : `${s}=${fmtSignal(s, p.signals[s])}`))
                    .join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
