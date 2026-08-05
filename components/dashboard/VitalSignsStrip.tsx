import { MetricCard } from '@/components/ui/MetricCard';
import { formatMoney } from '@/lib/engines/money';
import type { DashboardSummary } from '@/lib/engines/dashboard';

function ratioStatus(summary: DashboardSummary, key: string): 'good' | 'caution' | 'risk' | 'neutral' {
  return summary.ratios.find((r) => r.key === key)?.status ?? 'neutral';
}

export function VitalSignsStrip({ summary }: { summary: DashboardSummary }) {
  const surplusStatus: 'good' | 'caution' | 'risk' | 'neutral' =
    summary.monthlySurplus > 0 ? 'good' : summary.monthlySurplus < 0 ? 'risk' : 'neutral';

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <MetricCard label="Monthly Surplus" value={formatMoney(summary.monthlySurplus, summary.currency)} status={surplusStatus} />
      <MetricCard label="Net Worth" value={formatMoney(summary.netWorth, summary.currency)} status="neutral" />
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
