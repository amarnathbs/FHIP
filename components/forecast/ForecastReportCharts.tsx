'use client';

import { TrendLineChart, AllocationPieChart, GroupedBarChart } from '@/components/dashboard/charts';

interface ResultRow {
  period_number: number;
  period_date: string;
  closing_value: number;
  entity_id: string | null;
}

// Down-samples a long monthly series (retirement forecasts run out to 600
// months) to a readable number of chart points without losing the shape —
// always keeps the final point so the chart's right edge matches the report's
// own "in N years" figures.
function seriesFromResults(results: ResultRow[], entityId: string | null, maxPoints = 24) {
  const rows = results.filter((r) => r.entity_id === entityId).sort((a, b) => a.period_number - b.period_number);
  if (rows.length === 0) return [];
  const stride = Math.max(1, Math.ceil(rows.length / maxPoints));
  const out = rows.filter((_, i) => i % stride === 0 || i === rows.length - 1);
  return out.map((r) => ({ month: r.period_date.slice(0, 7), value: r.closing_value }));
}

// Sums closing_value across every entity for a period (e.g. total remaining
// balance across all liabilities) rather than charting one entity at a time.
function summedSeriesFromResults(results: ResultRow[], maxPoints = 24) {
  const byPeriod = new Map<number, { date: string; total: number }>();
  for (const r of results) {
    const cur = byPeriod.get(r.period_number) ?? { date: r.period_date, total: 0 };
    cur.total += r.closing_value;
    byPeriod.set(r.period_number, cur);
  }
  const rows = Array.from(byPeriod.entries()).sort((a, b) => a[0] - b[0]);
  if (rows.length === 0) return [];
  const stride = Math.max(1, Math.ceil(rows.length / maxPoints));
  const out = rows.filter((_, i) => i % stride === 0 || i === rows.length - 1);
  return out.map(([, v]) => ({ month: v.date.slice(0, 7), value: v.total }));
}

export function ReportTrendChart({
  results,
  currency,
  entityId = null,
  summed = false,
}: {
  results: ResultRow[];
  currency: 'AUD' | 'INR';
  entityId?: string | null;
  summed?: boolean;
}) {
  const data = summed ? summedSeriesFromResults(results) : seriesFromResults(results, entityId);
  return <TrendLineChart data={data} currency={currency} roundToWhole />;
}

export function ReportAllocationChart({ slices, currency }: { slices: { label: string; value: number }[]; currency: 'AUD' | 'INR' }) {
  return <AllocationPieChart slices={slices} currency={currency} roundToWhole />;
}

export function ReportScenarioBarChart({
  scenarios,
  currency,
}: {
  scenarios: { scenarioName: string; oneYear: number | null; fiveYear: number | null; tenYear: number | null }[];
  currency: 'AUD' | 'INR';
}) {
  const data = scenarios.map((s) => ({
    label: s.scenarioName,
    '1 Year': s.oneYear ?? 0,
    '5 Years': s.fiveYear ?? 0,
    '10 Years': s.tenYear ?? 0,
  }));
  return <GroupedBarChart data={data} seriesKeys={['1 Year', '5 Years', '10 Years']} currency={currency} roundToWhole />;
}

export function ReportVarianceBarChart({
  rows,
  currency,
}: {
  rows: { label: string; forecast: number | null; actual: number | null }[];
  currency: 'AUD' | 'INR';
}) {
  const data = rows
    .filter((r) => r.forecast !== null || r.actual !== null)
    .map((r) => ({ label: r.label, Forecast: r.forecast ?? 0, Actual: r.actual ?? 0 }));
  return <GroupedBarChart data={data} seriesKeys={['Forecast', 'Actual']} currency={currency} roundToWhole />;
}
