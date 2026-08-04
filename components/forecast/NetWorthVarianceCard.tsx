import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';

interface NetWorthVariance {
  hasOriginal: boolean;
  baselineDate: string | null;
  baselineNetWorth: number | null;
  actualNetWorth: number;
  actualIncreaseSinceBaseline: number | null;
  monthsSinceBaseline: number | null;
  originalForecastNetWorthToday: number | null;
  variance: number | null;
  variancePercentage: number | null;
}

export function NetWorthVarianceCard({ variance, currency }: { variance: NetWorthVariance; currency: 'AUD' | 'INR' }) {
  if (!variance.hasOriginal) {
    return (
      <SectionCard title="Actual vs Original Forecast" description="Compares today's real net worth against your very first net worth forecast.">
        <p className="text-sm text-gray-500">Generate a net worth forecast above to establish an original baseline to track against.</p>
      </SectionCard>
    );
  }

  const isAhead = variance.variance !== null && variance.variance >= 0;

  return (
    <SectionCard
      title="Actual vs Original Forecast"
      description={`Comparing today against the original forecast baselined on ${variance.baselineDate} (${variance.monthsSinceBaseline} month${variance.monthsSinceBaseline === 1 ? '' : 's'} ago).`}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Baseline net worth" value={variance.baselineNetWorth !== null ? formatMoney(variance.baselineNetWorth, currency) : '—'} />
        <Stat label="Actual net worth today" value={formatMoney(variance.actualNetWorth, currency)} />
        <Stat
          label="Original forecast for today"
          value={variance.originalForecastNetWorthToday !== null ? formatMoney(variance.originalForecastNetWorthToday, currency) : '—'}
        />
        <Stat
          label="Actual increase since baseline"
          value={variance.actualIncreaseSinceBaseline !== null ? formatMoney(variance.actualIncreaseSinceBaseline, currency) : '—'}
        />
      </div>
      {variance.variance !== null && (
        <p className={`mt-4 text-sm ${isAhead ? 'text-progress' : 'text-risk'}`}>
          {isAhead ? 'Ahead of' : 'Behind'} the original forecast by {formatMoney(Math.abs(variance.variance), currency)}
          {variance.variancePercentage !== null ? ` (${variance.variancePercentage >= 0 ? '+' : ''}${variance.variancePercentage.toFixed(1)}%)` : ''}.
        </p>
      )}
    </SectionCard>
  );
}
