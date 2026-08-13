'use client';

import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { formatMoneyWhole } from '@/lib/engines/money';
import { AllocationPieChart, GroupedBarChart } from '@/components/dashboard/charts';

// Same thin-wrapper pattern as components/forecast/ForecastReportCharts.tsx —
// reuse the generic recharts primitives directly; only build something new
// here when the spec's visual has no existing equivalent.

export function ReportAllocationChart({ slices, currency }: { slices: { label: string; value: number }[]; currency: 'AUD' | 'INR' }) {
  return <AllocationPieChart slices={slices} currency={currency} roundToWhole />;
}

export function ReportDebtBarChart({ rows, currency }: { rows: { debtType: string; balance: number }[]; currency: 'AUD' | 'INR' }) {
  const data = rows.map((r) => ({ label: r.debtType, Balance: r.balance }));
  return <GroupedBarChart data={data} seriesKeys={['Balance']} currency={currency} roundToWhole />;
}

const STATUS_COLORS: Record<'good' | 'caution' | 'risk' | 'neutral', string> = {
  good: '#198754',
  caution: '#B7791F',
  risk: '#C7362F',
  neutral: '#9CA3AF',
};

function statusFromBand(band: string): 'good' | 'caution' | 'risk' | 'neutral' {
  if (band === 'excellent' || band === 'good' || band === 'highly_resilient' || band === 'resilient') return 'good';
  if (band === 'fair' || band === 'moderately_vulnerable') return 'caution';
  if (band === 'needs_attention' || band === 'critical' || band === 'vulnerable' || band === 'fragile') return 'risk';
  return 'neutral';
}

// Income -> Expenses -> Surplus waterfall. Recharts has no built-in waterfall
// type; the standard technique is a stacked bar with an invisible "base"
// series beneath the visible "value" series so each bar floats at the right
// height. Two bars (Income, Expenses+Surplus) rather than three keeps the
// visual readable at report size.
export function CashFlowWaterfallChart({
  grossMonthlyIncome,
  netMonthlyIncome,
  totalMonthlyExpenses,
  debtMonthlyRepayments,
  monthlySurplus,
  currency,
}: {
  grossMonthlyIncome: number;
  netMonthlyIncome: number;
  totalMonthlyExpenses: number;
  debtMonthlyRepayments: number;
  monthlySurplus: number;
  currency: 'AUD' | 'INR';
}) {
  // Nothing recorded at all (no income, no expenses, no debt repayments) —
  // every other chart in this file shows an explicit "no data" message
  // rather than rendering a chart with nothing in it; the deficit
  // special-case below only covers the "recorded but negative" scenario,
  // not this one.
  if (grossMonthlyIncome === 0 && netMonthlyIncome === 0 && totalMonthlyExpenses === 0 && debtMonthlyRepayments === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-card border border-dashed bg-gray-50 px-4 text-center text-sm text-gray-500">
        No cash flow data recorded yet.
      </div>
    );
  }
  // Debt repayments are tracked separately from totalMonthlyExpenses
  // (dashboard.ts) but must still appear as their own visible bucket here —
  // otherwise the two bars don't sum to net income and a real repayment
  // amount goes invisible.
  const totalOutflow = totalMonthlyExpenses + debtMonthlyRepayments;
  const surplusPositive = Math.max(monthlySurplus, 0);
  const deficit = Math.max(-monthlySurplus, 0);
  const data = [
    { label: 'Net income', base: 0, Income: netMonthlyIncome, Expenses: 0, Debt: 0, Surplus: 0 },
    { label: 'Expenses, debt & surplus', base: 0, Income: 0, Expenses: totalMonthlyExpenses, Debt: debtMonthlyRepayments, Surplus: surplusPositive },
  ];
  if (grossMonthlyIncome > 0 && netMonthlyIncome < grossMonthlyIncome) {
    data[0] = { ...data[0], label: 'Gross → net income' };
  }
  if (deficit > 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-card border border-dashed bg-gray-50 px-4 text-center text-sm text-gray-500">
        Expenses and debt repayments ({formatMoneyWhole(totalOutflow, currency)} in total) exceed net income (
        {formatMoneyWhole(netMonthlyIncome, currency)}) this month — a deficit of {formatMoneyWhole(deficit, currency)}.
      </div>
    );
  }
  // Unlike the pie charts (which get a legend from recharts), a stacked bar
  // chart has no built-in color key at all — nothing told the reader which
  // segment color was income vs. expenses vs. debt vs. surplus. Same plain-
  // HTML legend pattern as AllocationPieChart, colors matched 1:1 to the
  // <Bar> fills below.
  const WATERFALL_LEGEND = [
    { label: 'Income', color: '#2563EB' },
    { label: 'Essential & discretionary expenses', color: '#C7362F' },
    { label: 'Debt repayments', color: '#B7791F' },
    { label: 'Surplus', color: '#198754' },
  ];
  return (
    <div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data}>
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatMoneyWhole(v, currency)} width={80} />
          <Tooltip formatter={(v: number) => formatMoneyWhole(v, currency)} />
          <Bar dataKey="Income" stackId="flow" fill="#2563EB" isAnimationActive={false} />
          <Bar dataKey="Expenses" stackId="flow" fill="#C7362F" isAnimationActive={false} />
          <Bar dataKey="Debt" stackId="flow" fill="#B7791F" isAnimationActive={false} />
          <Bar dataKey="Surplus" stackId="flow" fill="#198754" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
        {WATERFALL_LEGEND.map((item) => (
          <li key={item.label} className="flex items-center gap-1.5 text-sm">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} aria-hidden="true" />
            <span className="text-gray-700">{item.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A value bar with a shaded target range — used for emergency-fund months
// (Page 2/5) and reusable for any "here's your number, here's the healthy
// range" visual.
export function TargetZoneBar({
  value,
  targetMin,
  targetMax,
  displayMax,
  unit,
}: {
  value: number | null;
  targetMin: number;
  targetMax: number;
  displayMax: number;
  unit: string;
}) {
  if (value === null) {
    return (
      <div className="flex h-16 items-center justify-center rounded-card border border-dashed bg-gray-50 text-sm text-gray-500">
        Not enough data to calculate this yet.
      </div>
    );
  }
  const clampedValue = Math.max(0, Math.min(value, displayMax));
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / displayMax) * 100))}%`;
  const status = value < targetMin ? 'risk' : value > targetMax * 2 ? 'caution' : 'good';
  const fmt = (n: number) => `${n.toFixed(1)} ${unit}`;
  return (
    <div>
      <div className="relative h-3 w-full rounded-full bg-gray-100">
        <div
          className="absolute h-3 rounded-full bg-emerald-100"
          style={{ left: pct(targetMin), width: `calc(${pct(targetMax)} - ${pct(targetMin)})` }}
        />
        <div className="absolute h-3 rounded-full" style={{ width: pct(clampedValue), background: STATUS_COLORS[status] }} />
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-gray-500">
        <span>{fmt(value)}</span>
        <span>
          Target zone: {fmt(targetMin)}–{fmt(targetMax)}
        </span>
      </div>
    </div>
  );
}

export interface PillarRow {
  code: string;
  label: string;
  score: number | null;
  statusBand: string;
  explanation: string;
  treatment: string;
  whatItMeasures?: string | null;
  areaToReview?: string | null;
}

// Horizontal score-pillar bars — shows every pillar, including ones that
// couldn't be scored, with their own explanation instead of a blank dash
// (a missing_data pillar renders its explanation text where the bar would be).
// Per the spec, every pillar shows 4 distinct things: what it measures
// (generic, fixed), current score, meaning (household-specific), and one
// area to review.
export function PillarBars({ pillars }: { pillars: PillarRow[] }) {
  return (
    <div className="space-y-4">
      {pillars.map((p) => {
        const status = p.treatment === 'missing_data' || p.score === null ? 'neutral' : statusFromBand(p.statusBand);
        return (
          <div key={p.code} className="border-b border-gray-100 pb-4 last:border-0 last:pb-0">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-gray-900">{p.label}</span>
              <span style={{ color: STATUS_COLORS[status] }}>{p.score !== null ? `${Math.round(p.score)}/100` : 'Not available'}</span>
            </div>
            <div className="mt-1 h-2 w-full rounded-full bg-gray-100">
              {p.score !== null && (
                <div className="h-2 rounded-full" style={{ width: `${Math.max(0, Math.min(100, p.score))}%`, background: STATUS_COLORS[status] }} />
              )}
            </div>
            {p.whatItMeasures && <p className="mt-2 text-xs text-gray-500">{p.whatItMeasures}</p>}
            <p className="mt-1 text-xs text-gray-700">{p.explanation}</p>
            {p.areaToReview && (
              <p className="mt-1 text-xs text-gray-500">
                <span className="font-medium text-gray-600">Area to review: </span>
                {p.areaToReview}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface RiskRow {
  title: string;
  severity: string;
  explanation: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#8E1F0B',
  high: '#C7362F',
  medium: '#B7791F',
  low: '#9CA3AF',
};

// A small severity grid — no charting library needed, just a styled list.
// Only rendered when there's a non-empty risk list to show.
export function RiskSeverityMatrix({ risks }: { risks: RiskRow[] }) {
  if (risks.length === 0) return null;
  return (
    <div className="divide-y divide-gray-100 rounded-card border">
      {risks.map((r, i) => (
        <div key={i} className="flex items-start gap-3 px-4 py-3">
          <span
            className="mt-0.5 inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
            style={{ background: SEVERITY_COLORS[r.severity] ?? SEVERITY_COLORS.medium }}
            aria-hidden
          />
          <div>
            <p className="text-sm font-medium text-gray-900">{r.title}</p>
            <p className="text-xs text-gray-500">{r.explanation}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// A generic 0-100 score trend line (Financial Health Score / Financial
// Resilience history) — distinct from TrendLineChart, which always
// currency-formats its axis and is unsuitable for a score.
export function ScoreTrendChart({ data }: { data: { month: string; value: number }[] }) {
  if (data.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center rounded-card border border-dashed bg-gray-50 text-sm text-gray-500">
        Not enough history yet — check back after a few months of data.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={data}>
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} width={30} />
        <Tooltip formatter={(v: number) => `${v}/100`} />
        <Line type="monotone" dataKey="value" stroke="#2563EB" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export interface BulletRow {
  label: string;
  userValue: number | null;
  peerValue: number | null;
  healthyMin: number | null;
  healthyMax: number | null;
  comparisonStatus: string | null;
  // Caller-supplied, unit-aware formatted string (e.g. "$45,000", "12.5%",
  // "3.2 months") — the caller has the metric's unit and currency in scope,
  // this component doesn't. Falls back to a plain grouped number (no
  // currency symbol, no unit) only if the caller doesn't supply one.
  displayValue?: string;
}

function bulletStatus(status: string | null): 'good' | 'caution' | 'risk' | 'neutral' {
  if (status === 'ahead' || status === 'aligned') return 'good';
  if (status === 'behind') return 'risk';
  if (status === 'not_comparable') return 'neutral';
  return 'neutral';
}

// Per the spec's explicit "bullet charts, not competitive leaderboards"
// instruction — a user value bar against a shaded healthy range and a peer
// marker, one metric at a time, rather than a ranked list against named
// peers. Plain divs (same technique as PillarBars/TargetZoneBar) rather than
// a charting library, since each row's scale is independent of the others.
export function BulletChart({ rows }: { rows: BulletRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-4">
      {rows.map((r, i) => {
        const candidates = [r.userValue, r.peerValue, r.healthyMax, r.healthyMin].filter((v): v is number => v !== null);
        const max = candidates.length > 0 ? Math.max(...candidates) * 1.15 || 1 : 1;
        const pct = (n: number | null) => (n === null ? null : `${Math.max(0, Math.min(100, (n / max) * 100))}%`);
        const status = bulletStatus(r.comparisonStatus);
        const healthyLeft = r.healthyMin !== null ? pct(r.healthyMin) : null;
        const healthyWidth =
          r.healthyMin !== null && r.healthyMax !== null ? `calc(${pct(r.healthyMax)} - ${pct(r.healthyMin)})` : null;
        return (
          <div key={i}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-gray-900">{r.label}</span>
              <span style={{ color: STATUS_COLORS[status] }}>
                {r.displayValue ?? (r.userValue !== null ? r.userValue.toLocaleString() : 'Not available')}
              </span>
            </div>
            <div className="relative mt-1 h-3 w-full rounded-full bg-gray-100">
              {healthyLeft !== null && healthyWidth !== null && (
                <div className="absolute h-3 rounded-full bg-emerald-100" style={{ left: healthyLeft, width: healthyWidth }} />
              )}
              {r.userValue !== null && (
                <div className="absolute h-3 rounded-full" style={{ width: pct(r.userValue) ?? '0%', background: STATUS_COLORS[status] }} />
              )}
              {r.peerValue !== null && (
                <div className="absolute top-0 h-3 w-0.5 bg-gray-500" style={{ left: pct(r.peerValue) ?? '0%' }} title="Peer value" />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { statusFromBand, STATUS_COLORS };
