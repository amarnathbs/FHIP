import { WhatDoesThisMeanLink } from '@/components/resources/context/WhatDoesThisMeanLink';

export function MetricCard({
  label,
  value,
  trend,
  tooltip,
  status = 'neutral',
  contextResolved,
}: {
  label: string;
  value: string;
  trend?: string;
  tooltip?: string;
  status?: 'good' | 'caution' | 'risk' | 'neutral';
  // R1.6 (spec §57/§59-62): the CMS-resolved Resource for this metric's
  // registered context key, already looked up server-side by the caller
  // (see components/dashboard/VitalSignsStrip.tsx's header — MetricCard
  // itself never fetches). Omitted/undefined entirely by every pre-R1.6
  // caller, so this is a zero-behaviour-change addition for them.
  contextResolved?: { slug: string } | null;
}) {
  const ring = {
    good: 'ring-positive',
    caution: 'ring-attention',
    risk: 'ring-risk',
    neutral: 'ring-line',
  }[status];
  return (
    <div className={`rounded-card border border-line bg-white p-6 shadow-sm ring-1 ${ring}`} title={tooltip}>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums text-ink">{value}</p>
      {trend && <p className="mt-1 text-sm text-muted">{trend}</p>}
      {contextResolved !== undefined && <WhatDoesThisMeanLink resolved={contextResolved} metricLabel={label} />}
    </div>
  );
}
