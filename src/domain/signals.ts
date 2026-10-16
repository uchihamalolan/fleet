/**
 * Signal catalogue. Every signal carries its own freshness budget: a reading is
 * trusted only while (now - event_ts) <= staleAfterMs. A fresh speed packet never
 * refreshes an old battery reading because freshness is tracked per signal.
 */
export const SIGNALS = [
  'soc',
  'range_km',
  'odometer_km',
  'speed_kph',
  'ignition',
  'battery_temp_c',
  'lat',
  'lng',
] as const;

export type Signal = (typeof SIGNALS)[number];

export interface SignalSpec {
  label: string;
  unit: string;
  /** Reading older than this (event time) is stale and cannot back a claim. */
  staleAfterMs: number;
  decimals: number;
}

const MIN = 60_000;

export const SIGNAL_SPECS: Record<Signal, SignalSpec> = {
  soc: { label: 'State of charge', unit: '%', staleAfterMs: 10 * MIN, decimals: 0 },
  range_km: { label: 'Range', unit: 'km', staleAfterMs: 10 * MIN, decimals: 0 },
  odometer_km: { label: 'Odometer', unit: 'km', staleAfterMs: 60 * MIN, decimals: 0 },
  speed_kph: { label: 'Speed', unit: 'km/h', staleAfterMs: 5 * MIN, decimals: 0 },
  ignition: { label: 'Ignition', unit: '', staleAfterMs: 5 * MIN, decimals: 0 },
  battery_temp_c: { label: 'Battery temp', unit: '°C', staleAfterMs: 10 * MIN, decimals: 1 },
  lat: { label: 'Latitude', unit: '', staleAfterMs: 5 * MIN, decimals: 4 },
  lng: { label: 'Longitude', unit: '', staleAfterMs: 5 * MIN, decimals: 4 },
};

/** No packet of any kind (by event time) for this long => vehicle is offline. */
export const OFFLINE_AFTER_MS = 30 * MIN;

/** Packets received this long after they were produced are flagged as late. */
export const LATE_AFTER_MS = 60_000;

/** Consecutive packets further apart than this are shown as a missing interval. */
export const GAP_AFTER_MS = 5 * MIN;

/** Packets claiming an event time this far beyond receipt are treated as clock-skewed. */
export const MAX_FUTURE_SKEW_MS = 2 * MIN;

export const THRESHOLDS = {
  socWarning: 20,
  socCritical: 10,
  tempCritical: 45,
} as const;
