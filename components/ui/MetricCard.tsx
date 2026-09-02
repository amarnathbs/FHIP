import { WhatDoesThisMeanLink } from '@/components/resources/context/WhatDoesThisMeanLink';
import { ContextualExplain } from '@/components/aiExplain/ContextualExplain';

export function MetricCard({
  label,
  value,
  trend,
  tooltip,
  status = 'neutral',
  contextResolved,
  explain,
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
  // Module 11.5 (spec §22-26): the Premium PERSONALISED explanation for this
  // metric. Deliberately independent of `contextResolved` above — that is the
  // ordinary, non-Premium educational help ("what is net worth?") and spec
  // §22 requires it be preserved, not replaced. Both may render together.
  // Omitted by every pre-11.5 caller, so this is a zero-behaviour-change
  // addition for them, and ContextualExplain itself renders nothing when the
  // feature switch is off.
  explain?: { targetCode: string; accessibleLabel: string; targetId?: string | null; contextId?: string | null };
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
      {explain && (
        <ContextualExplain
          targetCode={explain.targetCode}
          targetId={explain.targetId}
          contextId={explain.contextId}
          accessibleLabel={explain.accessibleLabel}
        />
      )}
    </div>
  );
}
