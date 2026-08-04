'use client';

import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { formatMoney, formatMoneyWhole } from '@/lib/engines/money';

const PALETTE = [
  '#1F4E79', // trust navy
  '#0E9F8E', // progress teal
  '#D98A00', // caution amber
  '#C0392B', // risk red
  '#6C5CE7',
  '#00B894',
  '#E17055',
  '#0984E3',
  '#B2BEC3',
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
        <Line type="monotone" dataKey="value" stroke={PALETTE[0]} strokeWidth={2} dot={{ r: 3 }} />
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
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={nonZero} dataKey="value" nameKey="label" cx="50%" cy="50%" outerRadius={80} label>
          {nonZero.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v: number) => fmt(v, currency)} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
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
          <Bar key={key} dataKey={key} fill={PALETTE[i % PALETTE.length]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
