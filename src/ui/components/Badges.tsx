import { STATUS_LABEL } from '../../domain/derive';
import type { Signal } from '../../domain/signals';
import type { AttentionState, Freshness, Severity, VehicleStatus } from '../../domain/types';
import type { SignalView } from '../../db/store';
import { ago, fmtSignal } from '../format';

/** Every state pairs a distinct glyph with a text label, so colour is never the only cue. */
const STATUS_GLYPH: Record<VehicleStatus, string> = {
  critical: '◆',
  warning: '▲',
  unverified: '?',
  offline: '⊘',
  ok: '✓',
};

export function StatusBadge({ status }: { status: VehicleStatus }) {
  return (
    <span className={`badge status-${status}`}>
      <span aria-hidden="true" className="glyph">
        {STATUS_GLYPH[status]}
      </span>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SeverityTag({ severity }: { severity: Severity }) {
  return (
    <span className={`badge status-${severity}`}>
      <span aria-hidden="true" className="glyph">
        {STATUS_GLYPH[severity]}
      </span>
      {severity === 'critical' ? 'Critical' : 'Warning'}
    </span>
  );
}

const ATTENTION_LABEL: Record<AttentionState, string> = {
  needs_action: 'Needs action',
  acknowledged: 'Acknowledged',
  snoozed: 'Snoozed',
};

export function AttentionTag({ state, escalated }: { state: AttentionState; escalated?: boolean }) {
  return (
    <span className={`tag attention-${state}`}>
      {state === 'needs_action' ? '● ' : state === 'snoozed' ? '◷ ' : '✓ '}
      {ATTENTION_LABEL[state]}
      {escalated ? ' · escalated' : ''}
    </span>
  );
}

export function FreshnessTag({ freshness, ts, now }: { freshness: Freshness; ts?: number; now: number }) {
  if (freshness === 'missing') return <span className="fresh fresh-missing">no data</span>;
  if (freshness === 'stale')
    return (
      <span className="fresh fresh-stale" title="Too old to trust; not used for alerts">
        ⏱ stale · {ago(ts, now)}
      </span>
    );
  return <span className="fresh fresh-ok">{ago(ts, now)}</span>;
}

/** A value plus its freshness; stale values are visibly de-emphasised and labelled. */
export function Reading({ signal, view, now, compact }: { signal: Signal; view: SignalView | undefined; now: number; compact?: boolean }) {
  const freshness: Freshness = view?.freshness ?? 'missing';
  return (
    <span className={`reading reading-${freshness}${compact ? ' compact' : ''}`}>
      <span className="value">{fmtSignal(signal, view?.value)}</span>
      <FreshnessTag freshness={freshness} ts={view?.eventTs} now={now} />
    </span>
  );
}
