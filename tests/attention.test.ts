import { describe, expect, it } from 'vitest';
import { attentionState } from '../src/domain/attention';
import type { AlertAction } from '../src/domain/types';
import { MIN, T0 } from './helpers';

const action = (a: Partial<AlertAction>): AlertAction => ({
  id: 1,
  episodeId: 1,
  action: 'ack',
  severityAtAction: 'warning',
  untilTs: null,
  createdTs: T0,
  undoneTs: null,
  ...a,
});

const open = (peak: 'warning' | 'critical') => ({ peakSeverity: peak, closedTs: null });

describe('attentionState', () => {
  it('needs action when nothing was done', () => {
    expect(attentionState(open('warning'), [], T0).state).toBe('needs_action');
  });
  it('acknowledged covers the acknowledged severity', () => {
    expect(attentionState(open('warning'), [action({})], T0).state).toBe('acknowledged');
  });
  it('re-raises when the alert escalates past the acknowledged severity', () => {
    const s = attentionState(open('critical'), [action({ severityAtAction: 'warning' })], T0);
    expect(s).toEqual({ state: 'needs_action', escalatedSinceAction: true });
  });
  it('snooze expires', () => {
    const a = [action({ action: 'snooze', untilTs: T0 + 30 * MIN })];
    expect(attentionState(open('warning'), a, T0 + 10 * MIN).state).toBe('snoozed');
    expect(attentionState(open('warning'), a, T0 + 31 * MIN).state).toBe('needs_action');
  });
  it('undo restores the previous state', () => {
    const acts = [action({ id: 1, createdTs: T0 }), action({ id: 2, action: 'snooze', untilTs: T0 + 60 * MIN, createdTs: T0 + MIN, undoneTs: T0 + 2 * MIN })];
    expect(attentionState(open('warning'), acts, T0 + 3 * MIN).state).toBe('acknowledged');
    acts[0]!.undoneTs = T0 + 4 * MIN;
    expect(attentionState(open('warning'), acts, T0 + 5 * MIN).state).toBe('needs_action');
  });
});
