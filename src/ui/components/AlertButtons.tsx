import { useAlertActions } from '../../client/hooks';
import type { AttentionState } from '../../domain/types';
import { useUndoToast } from './Undo';

const KIND_LABEL = { battery_soc: 'battery alert', battery_temp: 'temperature alert' } as const;

export function AlertButtons({
  episodeId,
  vehicleName,
  kind,
  state,
  lastActionId,
}: {
  episodeId: number;
  vehicleName: string;
  kind: keyof typeof KIND_LABEL;
  state: AttentionState;
  lastActionId?: number | null;
}) {
  const { act, undo } = useAlertActions();
  const toast = useUndoToast();
  const what = `${vehicleName} ${KIND_LABEL[kind]}`;

  const run = async (action: 'ack' | 'snooze', snoozeMs?: number, label?: string) => {
    const id = await act.mutateAsync({ episodeId, action, snoozeMs });
    toast(`${label ?? 'Acknowledged'} ${what}`, id);
  };

  if (state !== 'needs_action' && lastActionId) {
    return (
      <div className="btn-row">
        <button className="btn" onClick={() => undo.mutate(lastActionId)} title="Undo the last action and return this to Needs action">
          ↺ Restore
        </button>
      </div>
    );
  }

  return (
    <div className="btn-row">
      <button className="btn primary" disabled={act.isPending} onClick={() => run('ack')}>
        Acknowledge
      </button>
      <button className="btn" disabled={act.isPending} onClick={() => run('snooze', 30 * 60_000, 'Snoozed 30 min:')}>
        Snooze 30m
      </button>
      <button className="btn" disabled={act.isPending} onClick={() => run('snooze', 2 * 3600_000, 'Snoozed 2 h:')}>
        2h
      </button>
      {act.error && <span className="error-text">{String((act.error as Error).message)}</span>}
    </div>
  );
}
