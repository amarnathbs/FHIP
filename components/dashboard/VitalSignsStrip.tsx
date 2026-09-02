import { MetricCard } from '@/components/ui/MetricCard';
import { formatMoney } from '@/lib/engines/money';
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
      {/* Module 11.5 (spec sections 23-25): the two highest-value Dashboard
          explanation entry points. Emergency Fund and Debt Service Ratio
          deliberately have NO Explain control here — they already carry the
          non-Premium educational link, and their personalised explanations
          live on the Resilience module where the certified source data is
          (spec section 7: prefer a small number of high-value entry points). */}
      <MetricCard
        label="Monthly Surplus"
        value={formatMoney(summary.monthlySurplus, summary.currency)}
        status={surplusStatus}
        explain={{ targetCode: 'DASHBOARD_CASH_FLOW', accessibleLabel: 'Explain your monthly surplus' }}
      />
      <MetricCard
        label="Net Worth"
        value={formatMoney(summary.netWorth, summary.currency)}
        status="neutral"
        contextResolved={contextLinks?.['dashboard.net_worth']}
        explain={{ targetCode: 'DASHBOARD_NET_WORTH', accessibleLabel: 'Explain your net worth' }}
      />
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
