import { useEffect, useMemo, useRef, useState } from 'react';
import { GAP_AFTER_MS } from '../../domain/signals';
import type { Interval } from '../../domain/history';

interface Props {
  label: string;
  unit: string;
  ts: number[];
  values: (number | null)[];
  from: number;
  to: number;
  gaps: Interval[];
  thresholds?: { value: number; label: string }[];
  yMin?: number;
  yMax?: number;
  height?: number;
}

const PAD = { l: 40, r: 10, t: 10, b: 22 };

/**
 * Minimal SVG time-series chart. Lines break across missing intervals instead of
 * interpolating, and the missing intervals are hatched, so absence of data is visible.
 */
export function LineChart({ label, unit, ts, values, from, to, gaps, thresholds = [], yMin, yMax, height = 140 }: Props) {
  // Render at the real pixel width so text and strokes are never stretched.
  const ref = useRef<HTMLElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pts = useMemo(() => {
    const out: { t: number; v: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
      const v = values[i];
      if (v !== null && v !== undefined) out.push({ t: ts[i]!, v });
    }
    return out;
  }, [ts, values]);

  const vs = pts.map((p) => p.v).concat(thresholds.map((t) => t.value));
  const lo = yMin ?? (vs.length ? Math.floor(Math.min(...vs) - 2) : 0);
  const hi = yMax ?? (vs.length ? Math.ceil(Math.max(...vs) + 2) : 1);
  const H = height;
  const x = (t: number) => PAD.l + ((t - from) / Math.max(1, to - from)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (H - PAD.t - PAD.b);

  let d = '';
  let prev: number | null = null;
  for (const p of pts) {
    d += `${prev === null || p.t - prev > GAP_AFTER_MS ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    prev = p.t;
  }

  const ticks = W < 500 ? 2 : 4;
  const hourTicks: number[] = [];
  const step = (to - from) / ticks;
  for (let i = 0; i <= ticks; i++) hourTicks.push(from + i * step);

  const last = pts[pts.length - 1];
  const summary = last ? `${label}: ${pts.length} readings, latest ${last.v}${unit}` : `${label}: no readings in this window`;

  return (
    <figure className="chart" ref={ref}>
      <figcaption>{label}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={summary}>
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="hatch-line" strokeWidth="2" />
          </pattern>
        </defs>
        {gaps.map((g, i) => (
          <rect key={i} x={x(g.from)} y={PAD.t} width={Math.max(1, x(g.to) - x(g.from))} height={H - PAD.t - PAD.b} fill="url(#hatch)" className="gap">
            <title>No data</title>
          </rect>
        ))}
        {[lo, (lo + hi) / 2, hi].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.l - 4} y={y(v) + 4} textAnchor="end" className="axis">
              {Math.round(v)}
            </text>
          </g>
        ))}
        {thresholds.map((t) => (
          <g key={t.label}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t.value)} y2={y(t.value)} className="threshold" />
            <text x={W - PAD.r - 2} y={y(t.value) - 3} textAnchor="end" className="threshold-label">
              {t.label}
            </text>
          </g>
        ))}
        <path d={d} className="series" fill="none" />
        {hourTicks.map((t, i) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === hourTicks.length - 1 ? 'end' : 'middle'} className="axis">
            {new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </text>
        ))}
      </svg>
    </figure>
  );
}
