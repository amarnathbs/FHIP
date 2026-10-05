// NAV2 -- the price chart as STATIC geometry (no browser measurement, no client-side chart library). Pure.
//
// The PDF is printed from a server-rendered page. A client-only chart (a responsive container that measures its parent after the page
// loads) can be missing at print time and, measured at the wrong width, can make the whole page shrink to fit; Stage 3 saw both. This
// module turns the chart data into fixed-size geometry (paths, tick positions and day-first labels) that a plain <svg> draws at once,
// so the printed chart is always there and always the same size.
//
// A line is never drawn across a material gap: a null row in the joined data ends one stretch and the next point starts a new one.
import type { ChartRow } from './presentation';

export interface StaticChartGeometry {
  width: number;
  height: number;
  plot: { left: number; top: number; right: number; bottom: number };
  /** One `d` attribute per series; empty when the series has fewer than two points. */
  paths: { nav: string; sma50: string; sma200: string };
  yTicks: Array<{ y: number; label: string }>;
  xTicks: Array<{ x: number; date: string }>;
}

const DAY = 86_400_000;
const t = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** "Nice" tick values covering [lo, hi] (about `n` of them). */
export function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, n - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 0.5 && out.length < 12; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function buildStaticChart(rows: readonly ChartRow[], formatDate: (iso: string) => string, formatY: (v: number) => string, width = 680, height = 205): StaticChartGeometry | null {
  const navRows = rows.filter((r) => r.nav !== null);
  if (navRows.length < 2) return null;
  const plot = { left: 52, top: 10, right: width - 12, bottom: height - 52 };
  const t0 = t(rows[0].date);
  const t1 = t(rows[rows.length - 1].date);
  const span = Math.max(DAY, t1 - t0);
  const values = rows.flatMap((r) => [r.nav, r.sma50, r.sma200]).filter((v): v is number => v !== null);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const ticksY = niceTicks(lo, hi, 5);
  const yMin = Math.min(lo, ticksY[0]);
  const yMax = Math.max(hi, ticksY[ticksY.length - 1]);
  const x = (iso: string): number => plot.left + ((t(iso) - t0) / span) * (plot.right - plot.left);
  const y = (v: number): number => plot.bottom - ((v - yMin) / Math.max(1e-9, yMax - yMin)) * (plot.bottom - plot.top);
  const f = (n: number): string => (Math.round(n * 10) / 10).toString();

  const pathFor = (pick: (r: ChartRow) => number | null): string => {
    const parts: string[] = [];
    let open = false;
    let points = 0;
    for (const r of rows) {
      const v = pick(r);
      if (v === null) {
        open = false;
        continue;
      }
      parts.push(`${open ? 'L' : 'M'}${f(x(r.date))},${f(y(v))}`);
      open = true;
      points += 1;
    }
    return points >= 2 ? parts.join('') : '';
  };

  const xTicks: Array<{ x: number; date: string }> = [];
  const count = 6;
  for (let i = 0; i < count; i++) {
    const ms = t0 + (span * i) / (count - 1);
    const d = new Date(ms).toISOString().slice(0, 10);
    xTicks.push({ x: x(d), date: formatDate(d) });
  }
  return {
    width,
    height,
    plot,
    paths: { nav: pathFor((r) => r.nav), sma50: pathFor((r) => r.sma50), sma200: pathFor((r) => r.sma200) },
    yTicks: ticksY.map((v) => ({ y: y(v), label: formatY(v) })),
    xTicks,
  };
}
