import { buildStaticChart } from '@/lib/engines/nav2/staticChart';
import type { FundAnalyticsSchemeBlock } from '@/lib/engines/nav2/fundAnalyticsReport';
import { chartRowsWithGaps } from '@/lib/engines/nav2/presentation';
import { showDate, type Nav2Context } from '@/lib/engines/nav2/types';

// The price chart of the PRINT document: plain inline SVG drawn from fixed geometry (lib/engines/nav2/staticChart.ts). No client-side
// chart library, no measurement after load: it is part of the server-rendered HTML, so it is present when the PDF is printed and it
// scales with the page width (viewBox) instead of being sized by the browser window. Dates on the axis are day-first.
export default function StaticNavChart({ block, ctx }: { block: FundAnalyticsSchemeBlock; ctx: Nav2Context }) {
  const rows = chartRowsWithGaps(block.chart);
  const g = buildStaticChart(rows, (d) => showDate(ctx, d), (v) => v.toLocaleString('en-IN', { maximumFractionDigits: v < 100 ? 1 : 0 }));
  if (!g) return <p className="fa-sub">Not enough price history to draw a chart.</p>;
  const legendY = g.height - 10;
  const lines: Array<{ d: string; color: string; w: number; label: string }> = [
    { d: g.paths.nav, color: '#2563eb', w: 1.4, label: 'NAV' },
    { d: g.paths.sma50, color: '#16a34a', w: 1, label: 'SMA 50' },
    { d: g.paths.sma200, color: '#9333ea', w: 1, label: 'SMA 200' },
  ];
  return (
    <figure className="fa-figure" role="img" aria-label={`Price (NAV) history of ${block.schemeName} with the 50 and 200 observation simple moving averages. The line is broken wherever price history is missing.`}>
      <svg viewBox={`0 0 ${g.width} ${g.height}`} width="100%" preserveAspectRatio="xMidYMid meet" className="fa-chart-svg" data-fa-chart="true">
        {g.yTicks.map((t) => (
          <g key={t.label + t.y}>
            <line x1={g.plot.left} x2={g.plot.right} y1={t.y} y2={t.y} stroke="#dde3ea" strokeDasharray="3 3" strokeWidth="0.7" />
            <text x={g.plot.left - 6} y={t.y + 3.5} textAnchor="end" fontSize="10" fill="#5b677a">
              {t.label}
            </text>
          </g>
        ))}
        <line x1={g.plot.left} x2={g.plot.right} y1={g.plot.bottom} y2={g.plot.bottom} stroke="#5b677a" strokeWidth="0.8" />
        {g.xTicks.map((t, i) => (
          <g key={t.date + i}>
            <line x1={t.x} x2={t.x} y1={g.plot.bottom} y2={g.plot.bottom + 4} stroke="#5b677a" strokeWidth="0.8" />
            <text x={t.x} y={g.plot.bottom + 17} textAnchor={i === 0 ? 'start' : i === g.xTicks.length - 1 ? 'end' : 'middle'} fontSize="10" fill="#5b677a">
              {t.date}
            </text>
          </g>
        ))}
        {lines.map((l) => (l.d ? <path key={l.label} d={l.d} fill="none" stroke={l.color} strokeWidth={l.w} strokeLinejoin="round" strokeLinecap="round" /> : null))}
        {lines.map((l, i) => (
          <g key={l.label} transform={`translate(${g.plot.left + 150 + i * 90},${legendY})`}>
            <line x1="0" x2="18" y1="-3.5" y2="-3.5" stroke={l.color} strokeWidth="2" />
            <text x="24" y="0" fontSize="10" fill="#172033">
              {l.label}
            </text>
          </g>
        ))}
      </svg>
      {block.chart.gaps.length > 0 && <figcaption className="fa-sub">The line is broken where {block.chart.gaps.length} stretch(es) of price history are missing; nothing is filled in.</figcaption>}
      {block.chart.downsampled && <figcaption className="fa-sub">The chart shows a sample of the daily prices; the figures use every price.</figcaption>}
    </figure>
  );
}
