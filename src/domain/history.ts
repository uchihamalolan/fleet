export interface Interval {
  from: number;
  to: number;
  /** True when the interval is still open (no packet since `from`). */
  ongoing?: boolean;
}

/**
 * Missing intervals in a vehicle's event-time series. Heuristic: any gap longer than
 * `threshold` between consecutive packets (by event time) is a gap. Late/backfilled
 * packets fill gaps retroactively because this is recomputed from the stored log.
 */
export function findGaps(sortedEventTs: number[], threshold: number, from: number, now: number): Interval[] {
  const gaps: Interval[] = [];
  let prev = from;
  for (const ts of sortedEventTs) {
    if (ts < from) continue;
    if (ts - prev > threshold) gaps.push({ from: prev, to: ts });
    prev = Math.max(prev, ts);
  }
  if (now - prev > threshold) gaps.push({ from: prev, to: now, ongoing: true });
  return gaps;
}
