import { MetricCard } from '@/components/ui/MetricCard';
import { formatMoneyWhole } from '@/lib/engines/money';
import type { DashboardSummary } from '@/lib/engines/dashboard';

function ratioStatus(summary: DashboardSummary, key: string): 'good' | 'caution' | 'risk' | 'neutral' {
  return summary.ratios.find((r) => r.key === key)?.status ?? 'neutral';
}

// R1.6 (spec §66): Dashboard is a 'use client' tree, so an async Server
// Component (WhatDoesThisMean) cannot be mounted inside it directly — the
// parent Server Component page (app/(app)/dashboard/page.tsx) resolves every
// mapped context key once via resolveContextResources() and passes the
// result down as a plain prop, which MetricCard then renders through the
// presentational WhatDoesThisMeanLink. See that component's header for the
// full explanation of why this split exists.
export interface DashboardContextLinks {
  'dashboard.net_worth'?: { slug: string } | null;
  'dashboard.emergency_fund'?: { slug: string } | null;
  'dashboard.debt_service_ratio'?: { slug: string } | null;
}

export function VitalSignsStrip({ summary, contextLinks }: { summary: DashboardSummary; contextLinks?: DashboardContextLinks }) {
  const surplusStatus: 'good' | 'caution' | 'risk' | 'neutral' =
    summary.monthlySurplus > 0 ? 'good' : summary.monthlySurplus < 0 ? 'risk' : 'neutral';

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {/* App Review spec §14: KPI cards round to the nearest whole currency
          unit (e.g. "-$1,630" not "-$1,630.06") — display formatting only,
          computed off the same unrounded summary.monthlySurplus/netWorth
          values used everywhere else, so nothing about the underlying
          calculation changes. Detailed/drill-down tables elsewhere keep
          using formatMoney (with cents). */}
      <MetricCard label="Monthly Surplus" value={formatMoneyWhole(summary.monthlySurplus, summary.currency)} status={surplusStatus} />
      <MetricCard label="Net Worth" value={formatMoneyWhole(summary.netWorth, summary.currency)} status="neutral" contextResolved={contextLinks?.['dashboard.net_worth']} />
      <MetricCard
        label="Emergency Fund"
        value={summary.emergencyFundMonths === null ? '—' : `${summary.emergencyFundMonths.toFixed(1)} mo`}
        status={ratioStatus(summary, 'emergency_fund_ratio')}
        contextResolved={contextLinks?.['dashboard.emergency_fund']}
      />
      <MetricCard
        label="Debt Service Ratio"
        value={summary.debtServiceRatio === null ? '—' : `${(summary.debtServiceRatio * 100).toFixed(1)}%`}
        status={ratioStatus(summary, 'debt_service_ratio')}
        contextResolved={contextLinks?.['dashboard.debt_service_ratio']}
      />
    </div>
  );
}
