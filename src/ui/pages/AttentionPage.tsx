import { Link, useSearchParams } from 'react-router-dom';
import { useAttention, useNow } from '../../client/hooks';
import type { AttentionItem } from '../../db/store';
import type { AttentionState } from '../../domain/types';
import { AlertButtons } from '../components/AlertButtons';
import { AttentionTag, FreshnessTag, SeverityTag } from '../components/Badges';
import { ago, clock } from '../format';

type Tab = AttentionState | 'unverified' | 'closed';

const KIND = { battery_soc: 'Battery charge', battery_temp: 'Battery temperature' } as const;

function conditionText(i: { kind: AttentionItem['kind']; severity: AttentionItem['severity']; value: number }) {
  if (i.kind === 'battery_temp') return `Battery overheating — ${i.value.toFixed(1)}°C (limit 45°C)`;
  return i.severity === 'critical'
    ? `Battery critically low — ${i.value.toFixed(0)}% (below 10%)`
    : `Low battery — ${i.value.toFixed(0)}% (below 20%)`;
}

export function AttentionPage() {
  const { data } = useAttention();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab | null) ?? 'needs_action';
  if (!data) return <p className="muted">Loading…</p>;

  const by = (s: AttentionState) => data.items.filter((i) => i.attention === s);
  const tabs: { id: Tab; label: string; count: number; help: string }[] = [
    { id: 'needs_action', label: 'Needs action', count: by('needs_action').length, help: 'Active alerts from fresh data that nobody has handled.' },
    { id: 'snoozed', label: 'Snoozed', count: by('snoozed').length, help: 'Hidden until the snooze ends, or sooner if the alert escalates.' },
    { id: 'acknowledged', label: 'Acknowledged', count: by('acknowledged').length, help: 'Seen by an operator. Comes back if it escalates.' },
    { id: 'unverified', label: "Can't verify", count: data.unverified.length, help: 'Last known reading was alerting but is now too old to trust. Not an active alert.' },
    { id: 'closed', label: 'Closed (6 h)', count: data.closed.length, help: 'Recovered, or closed because the data went stale.' },
  ];
  const current = tabs.find((t) => t.id === tab)!;

  return (
    <div className="page attention-page">
      <div role="tablist" className="tabs" aria-label="Attention queue">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setParams({ tab: t.id }, { replace: true })}>
            {t.label} <span className="count">{t.count}</span>
          </button>
        ))}
      </div>
      <p className="muted small">{current.help}</p>

      {(tab === 'needs_action' || tab === 'snoozed' || tab === 'acknowledged') && (
        <ul className="alert-list">
          {by(tab).length === 0 && <li className="muted">Nothing here.</li>}
          {by(tab).map((i) => (
            <li key={i.episodeId} className={`alert-item sev-${i.severity}`}>
              <SeverityTag severity={i.severity} />
              <div className="alert-main">
                <div>
                  <Link to={`/vehicles/${i.vehicleId}`}>
                    <strong>{i.vehicleName}</strong>
                  </Link>{' '}
                  <span className="muted">{i.depot}</span>
                </div>
                <div>{conditionText(i)}</div>
                <div className="small muted">
                  reading <FreshnessTag freshness={i.readingFreshness} ts={i.valueTs} now={now} /> · open {ago(i.openedTs, now)}
                  {i.lastAction && i.attention !== 'needs_action' && (
                    <> · {i.lastAction.action === 'ack' ? `acknowledged ${ago(i.lastAction.createdTs, now)}` : `snoozed until ${clock(i.lastAction.untilTs)}`}</>
                  )}
                </div>
                {i.escalatedSinceAction && <div className="small strong">Escalated after it was handled — needs a fresh look.</div>}
              </div>
              <AttentionTag state={i.attention} escalated={i.escalatedSinceAction} />
              <AlertButtons episodeId={i.episodeId} vehicleName={i.vehicleName} kind={i.kind} state={i.attention} lastActionId={i.lastAction?.id} />
            </li>
          ))}
        </ul>
      )}

      {tab === 'unverified' && (
        <ul className="alert-list">
          {data.unverified.length === 0 && <li className="muted">Nothing here.</li>}
          {data.unverified.map((u) => (
            <li key={`${u.vehicleId}-${u.kind}`} className="alert-item sev-unknown">
              <span className="badge status-unverified">? Unverified</span>
              <div className="alert-main">
                <div>
                  <Link to={`/vehicles/${u.vehicleId}`}>
                    <strong>{u.vehicleName}</strong>
                  </Link>{' '}
                  <span className="muted">{u.depot}</span>
                </div>
                <div>
                  {KIND[u.kind]} was {u.severity} ({u.kind === 'battery_soc' ? `${u.value.toFixed(0)}%` : `${u.value.toFixed(1)}°C`}) at last report
                </div>
                <div className="small muted">
                  <FreshnessTag freshness="stale" ts={u.eventTs} now={now} /> — current state unknown; contact the driver or wait for data.
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === 'closed' && (
        <ul className="alert-list">
          {data.closed.length === 0 && <li className="muted">Nothing here.</li>}
          {data.closed.map((c) => (
            <li key={c.id} className="alert-item closed">
              <span className="tag">{c.closeReason === 'recovered' ? '✓ Recovered' : '⏱ Data went stale'}</span>
              <div className="alert-main">
                <div>
                  <Link to={`/vehicles/${c.vehicleId}`}>
                    <strong>{c.vehicleName}</strong>
                  </Link>{' '}
                  {KIND[c.kind]} — peaked {c.peakSeverity}
                </div>
                <div className="small muted">
                  {clock(c.openedTs)} → {clock(c.closedTs)}
                  {c.closeReason === 'stale' && ' · closed because no fresh reading confirms it; it reopens if fresh data still breaches'}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
