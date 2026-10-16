import { sevRank } from './derive';
import type { AlertAction, AlertEpisode, AttentionState } from './types';

/**
 * Operator attention state for an *open* alert episode.
 *
 * Rules (deterministic):
 * - Only the most recent action that has not been undone counts.
 * - An acknowledgement covers the severity it was given at. If the episode later
 *   escalates above that severity, the item needs action again.
 * - A snooze hides the item until `untilTs`, unless the episode escalates.
 * - De-escalation never re-raises an item.
 * - Actions are scoped to one episode. When an episode closes (recovered, or data
 *   went stale) and a new one later opens, it starts un-acknowledged.
 */
export function attentionState(
  episode: Pick<AlertEpisode, 'peakSeverity' | 'closedTs'>,
  actions: Pick<AlertAction, 'action' | 'severityAtAction' | 'untilTs' | 'createdTs' | 'undoneTs'>[],
  now: number,
): { state: AttentionState; escalatedSinceAction: boolean } {
  const live = actions.filter((a) => a.undoneTs === null).sort((a, b) => b.createdTs - a.createdTs);
  const last = live[0];
  if (!last) return { state: 'needs_action', escalatedSinceAction: false };
  const escalated = sevRank(episode.peakSeverity) > sevRank(last.severityAtAction);
  if (escalated) return { state: 'needs_action', escalatedSinceAction: true };
  if (last.action === 'ack') return { state: 'acknowledged', escalatedSinceAction: false };
  if (last.untilTs !== null && now < last.untilTs) return { state: 'snoozed', escalatedSinceAction: false };
  return { state: 'needs_action', escalatedSinceAction: false };
}
