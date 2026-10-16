import { SIGNAL_SPECS, type Signal } from '../domain/signals';

export function ago(ts: number | null | undefined, now: number): string {
  if (ts === null || ts === undefined) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function clock(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtSignal(signal: Signal, value: number | undefined | null): string {
  if (value === undefined || value === null) return '—';
  if (signal === 'ignition') return value ? 'On' : 'Off';
  const spec = SIGNAL_SPECS[signal];
  return `${value.toFixed(spec.decimals)}${spec.unit && spec.unit !== '%' ? ' ' : ''}${spec.unit}`;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
