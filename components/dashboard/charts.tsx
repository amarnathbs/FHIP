'use client';

import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { formatMoney, formatMoneyWhole } from '@/lib/engines/money';

const PALETTE = [
  '#2563EB', // primary blue
  '#198754', // positive
  '#B7791F', // attention
  '#C7362F', // risk
  '#6D5BD0', // AI/alternative-scenario purple
  '#0E7490', // information teal
  '#C25A24', // secondary warm accent
  '#4C6EF5', // secondary blue accent
  '#9CA3AF', // neutral grey
];

export function TrendLineChart({
  data,
  currency,
  roundToWhole = false,
}: {
  data: { month: string; value: number }[];
  currency: 'AUD' | 'INR';
  roundToWhole?: boolean;
}) {
  const fmt = roundToWhole ? formatMoneyWhole : formatMoney;
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
        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmt(v, currency)} width={80} />
        <Tooltip formatter={(v: number) => fmt(v, currency)} />
        <Line type="monotone" dataKey="value" stroke={PALETTE[0]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function AllocationPieChart({
  slices,
  currency,
  roundToWhole = false,
}: {
  slices: { label: string; value: number }[];
  currency: 'AUD' | 'INR';
  roundToWhole?: boolean;
}) {
  const fmt = roundToWhole ? formatMoneyWhole : formatMoney;
  const nonZero = slices.filter((s) => s.value > 0);
  if (nonZero.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-card border border-dashed bg-gray-50 text-sm text-gray-500">
        No data yet.
      </div>
    );
  }
  // The legend is rendered as plain HTML below the chart rather than
  // recharts' built-in <Legend/> (and the pie's inline value labels are
  // dropped entirely) — with 6+ slices the built-in legend wraps to 2-3
  // lines inside the same fixed-height SVG box the pie's own edge labels
  // are drawn in, and the two collide (e.g. a value label landing on top
  // of a wrapped legend entry). An HTML legend reserves its own space in
  // normal document flow instead of sharing the canvas, and folding the
  // value into each legend row means dropping the inline pie labels loses
  // no information.
  return (
    <div>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={nonZero} dataKey="value" nameKey="label" cx="50%" cy="50%" outerRadius={80} isAnimationActive={false}>
            {nonZero.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(v: number) => fmt(v, currency)} />
        </PieChart>
      </ResponsiveContainer>
      <ul className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
        {nonZero.map((s, i) => (
          <li key={s.label} className="flex items-center gap-1.5 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
              aria-hidden="true"
            />
            <span className="text-gray-700">{s.label}</span>
            <span className="text-gray-500">{fmt(s.value, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GroupedBarChart({
  data,
  seriesKeys,
  currency,
  roundToWhole = false,
}: {
  data: Record<string, string | number>[];
  seriesKeys: string[];
  currency: 'AUD' | 'INR';
  roundToWhole?: boolean;
}) {
  const fmt = roundToWhole ? formatMoneyWhole : formatMoney;
  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-card border border-dashed bg-gray-50 text-sm text-gray-500">
        No data yet.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data}>
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmt(v, currency)} width={80} />
        <Tooltip formatter={(v: number) => fmt(v, currency)} />
        <Legend />
        {seriesKeys.map((key, i) => (
          <Bar key={key} dataKey={key} fill={PALETTE[i % PALETTE.length]} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
