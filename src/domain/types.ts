import type { Signal } from './signals';

/** A telemetry packet as emitted by a vehicle. `ts` is event time (vehicle clock, ms). */
export interface Packet {
  vehicleId: string;
  /** Per-vehicle monotonically increasing sequence number assigned by the vehicle. */
  seq: number;
  ts: number;
  signals: Partial<Record<Signal, number>>;
}

/** A packet together with the time the browser received it. */
export interface ReceivedPacket extends Packet {
  receivedTs: number;
}

export type Freshness = 'fresh' | 'stale' | 'missing';

export interface SignalReading {
  value: number;
  eventTs: number;
  receivedTs: number;
}

export type LatestSignals = Partial<Record<Signal, SignalReading>>;

export type Severity = 'warning' | 'critical';
export type AlertKind = 'battery_soc' | 'battery_temp';

export type VehicleStatus = 'critical' | 'warning' | 'unverified' | 'offline' | 'ok';

export type AttentionState = 'needs_action' | 'acknowledged' | 'snoozed';

export interface AlertEpisode {
  id: number;
  vehicleId: string;
  kind: AlertKind;
  severity: Severity;
  peakSeverity: Severity;
  value: number;
  valueTs: number;
  openedTs: number;
  closedTs: number | null;
  closeReason: 'recovered' | 'stale' | null;
}

export interface AlertAction {
  id: number;
  episodeId: number;
  action: 'ack' | 'snooze';
  severityAtAction: Severity;
  untilTs: number | null;
  createdTs: number;
  undoneTs: number | null;
}
