import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useFleet, useNow } from '../../client/hooks';
import { STATUS_ORDER } from '../../domain/derive';
import type { VehicleStatus } from '../../domain/types';
import type { FleetRow } from '../../db/store';
import { AttentionTag, Reading, StatusBadge } from '../components/Badges';
import { ago } from '../format';

type Sort = 'triage' | 'soc' | 'temp' | 'contact' | 'id';

const SORTS: Record<Sort, { label: string; cmp: (a: FleetRow, b: FleetRow) => number }> = {
  triage: {
    label: 'Most urgent first',
    cmp: (a, b) => a.triage - b.triage || (a.signals.soc?.value ?? 101) - (b.signals.soc?.value ?? 101),
  },
  soc: { label: 'Lowest battery', cmp: (a, b) => (a.signals.soc?.value ?? 101) - (b.signals.soc?.value ?? 101) },
  temp: {
    label: 'Hottest battery',
    cmp: (a, b) => (b.signals.battery_temp_c?.value ?? -99) - (a.signals.battery_temp_c?.value ?? -99),
  },
  contact: { label: 'Longest silent', cmp: (a, b) => (a.lastContactTs ?? 0) - (b.lastContactTs ?? 0) },
  id: { label: 'Vehicle ID', cmp: (a, b) => a.id.localeCompare(b.id) },
};

const STATUS_HELP: Record<VehicleStatus, string> = {
  critical: 'Fresh reading crosses a critical threshold',
  warning: 'Fresh reading crosses a warning threshold',
  unverified: 'Reporting, but battery data is stale or missing',
  offline: 'No telemetry for 30+ min',
  ok: 'Battery data fresh and within limits',
};

export function FleetPage() {
  const { data, isLoading, error } = useFleet();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as VehicleStatus | null) ?? null;
  const sort = (params.get('sort') as Sort | null) ?? 'triage';
  const q = params.get('q') ?? '';
  const depot = params.get('depot') ?? '';
  const needsAction = params.get('needs') === '1';
  const staleOnly = params.get('stale') === '1';

  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null || v === '') next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };

  const rows = data?.rows ?? [];
  const counts = useMemo(() => {
    const c: Record<VehicleStatus, number> = { critical: 0, warning: 0, unverified: 0, offline: 0, ok: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);
  const depots = useMemo(() => [...new Set(rows.map((r) => r.depot))].sort(), [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter(
        (r) =>
          (!status || r.status === status) &&
          (!depot || r.depot === depot) &&
          (!needsAction || r.attention === 'needs_action') &&
          (!staleOnly || r.signals.soc?.freshness !== 'fresh' || r.signals.battery_temp_c?.freshness !== 'fresh') &&
          (!needle || r.id.toLowerCase().includes(needle) || r.depot.toLowerCase().includes(needle)),
      )
      .sort(SORTS[sort].cmp);
  }, [rows, status, depot, needsAction, staleOnly, q, sort]);

  if (error) return <p className="error-text">Could not read the local database: {String(error)}</p>;
  if (isLoading) return <p className="muted">Loading fleet from local database…</p>;

  return (
    <div className="page fleet-page">
      <section className="segments" aria-label="Filter by status">
        <button className={`segment ${!status ? 'active' : ''}`} aria-pressed={!status} onClick={() => set('status', null)}>
          <span className="segment-count">{rows.length}</span>
          <span className="segment-label">All vehicles</span>
        </button>
        {STATUS_ORDER.map((s) => (
          <button
            key={s}
            className={`segment segment-${s} ${status === s ? 'active' : ''}`}
            aria-pressed={status === s}
            onClick={() => set('status', status === s ? null : s)}
            title={STATUS_HELP[s]}
          >
            <span className="segment-count">{counts[s]}</span>
            <span className="segment-label">
              <StatusBadge status={s} />
            </span>
            <span className="segment-help">{STATUS_HELP[s]}</span>
          </button>
        ))}
      </section>

      <section className="toolbar" aria-label="Refine">
        <input type="search" placeholder="Search vehicle or depot" value={q} onChange={(e) => set('q', e.target.value)} aria-label="Search" />
        <select value={depot} onChange={(e) => set('depot', e.target.value)} aria-label="Depot">
          <option value="">All depots</option>
          {depots.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select value={sort} onChange={(e) => set('sort', e.target.value === 'triage' ? null : e.target.value)} aria-label="Sort">
          {Object.entries(SORTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={needsAction} onChange={(e) => set('needs', e.target.checked ? '1' : null)} />
          Unhandled alerts only
        </label>
        <label className="check">
          <input type="checkbox" checked={staleOnly} onChange={(e) => set('stale', e.target.checked ? '1' : null)} />
          Stale battery data
        </label>
        <span className="muted result-count">
          {filtered.length} of {rows.length} shown
        </span>
      </section>

      <FleetTable rows={filtered} now={now} />
    </div>
  );
}

function FleetTable({ rows, now }: { rows: FleetRow[]; now: number }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 52, overscan: 12 });

  return (
    <div className="table" role="table" aria-label="Vehicles" aria-rowcount={rows.length + 1}>
      <div className="tr th" role="row">
        <span role="columnheader">Status</span>
        <span role="columnheader">Vehicle</span>
        <span role="columnheader">Why</span>
        <span role="columnheader">Battery</span>
        <span role="columnheader">Batt temp</span>
        <span role="columnheader">Speed</span>
        <span role="columnheader">Last heard</span>
        <span role="columnheader">Alert handling</span>
      </div>
      <div ref={parentRef} className="tbody" data-testid="fleet-scroll">
        {rows.length === 0 && <p className="muted pad">No vehicles match these filters.</p>}
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vi) => {
            const r = rows[vi.index]!;
            return (
              <div
                key={r.id}
                role="row"
                aria-rowindex={vi.index + 2}
                className={`tr row-${r.status}`}
                style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}
                onClick={() => navigate(`/vehicles/${r.id}`)}
              >
                <span role="cell">
                  <StatusBadge status={r.status} />
                </span>
                <span role="cell" className="vehicle-cell">
                  <Link to={`/vehicles/${r.id}`} onClick={(e) => e.stopPropagation()}>
                    {r.name}
                  </Link>
                  <small className="muted">{r.depot}</small>
                </span>
                <span role="cell" className="why" title={r.reasons.join('\n')}>
                  {r.reasons[0] ?? <span className="muted">All battery signals fresh</span>}
                  {r.reasons.length > 1 && <small className="muted"> +{r.reasons.length - 1} more</small>}
                </span>
                <span role="cell">
                  <Reading signal="soc" view={r.signals.soc} now={now} compact />
                </span>
                <span role="cell">
                  <Reading signal="battery_temp_c" view={r.signals.battery_temp_c} now={now} compact />
                </span>
                <span role="cell">
                  <Reading signal="speed_kph" view={r.signals.speed_kph} now={now} compact />
                </span>
                <span role="cell" className={r.status === 'offline' ? 'strong' : ''}>
                  {ago(r.lastContactTs, now)}
                </span>
                <span role="cell">
                  {r.attention ? (
                    <AttentionTag state={r.attention} escalated={r.alerts.some((a) => a.escalatedSinceAction)} />
                  ) : r.staleBreach ? (
                    <span className="tag">Last known: alerting</span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
