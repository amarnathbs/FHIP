import { MetricCard } from '@/components/ui/MetricCard';
import { formatMoneyWhole } from '@/lib/engines/money';
import type { DashboardSummary } from '@/lib/engines/dashboard';

function ratioStatus(summary: DashboardSummary, key: string): 'good' | 'caution' | 'risk' | 'neutral' {
  return summary.ratios.find((r) => r.key === key)?.status ?? 'neutral';
}

export function VitalSignsStrip({ summary }: { summary: DashboardSummary }) {
  const surplusStatus: 'good' | 'caution' | 'risk' | 'neutral' =
    summary.monthlySurplus > 0 ? 'good' : summary.monthlySurplus < 0 ? 'risk' : 'neutral';

  // Spec 1 §14: headline KPI cards show whole-currency-unit amounts, not
  // cents — formatting only, underlying calculation precision is untouched.
  // Detailed drill-down sections (components/dashboard/sections.tsx) keep
  // formatMoney's cents precision, unaffected by this change.
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <MetricCard label="Monthly Surplus" value={formatMoneyWhole(summary.monthlySurplus, summary.currency)} status={surplusStatus} />
      <MetricCard label="Net Worth" value={formatMoneyWhole(summary.netWorth, summary.currency)} status="neutral" />
      <MetricCard
        label="Emergency Fund"
        value={summary.emergencyFundMonths === null ? '—' : `${summary.emergencyFundMonths.toFixed(1)} mo`}
        status={ratioStatus(summary, 'emergency_fund_ratio')}
      />
      <MetricCard
        label="Debt Service Ratio"
        value={summary.debtServiceRatio === null ? '—' : `${(summary.debtServiceRatio * 100).toFixed(1)}%`}
        status={ratioStatus(summary, 'debt_service_ratio')}
      />
    </div>
  );
}
