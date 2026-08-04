import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import type { CategoryForecastResult, ScenarioCode } from '@/lib/engines/goalForecast';

const SCENARIO_LABEL: Record<ScenarioCode, string> = { conservative: 'Conservative', base: 'Base', optimistic: 'Optimistic' };

export function ScenarioTable({
  forecasts,
  currency,
}: {
  forecasts: Record<ScenarioCode, CategoryForecastResult>;
  currency: 'AUD' | 'INR';
}) {
  const order: ScenarioCode[] = ['conservative', 'base', 'optimistic'];
  return (
    <SectionCard
      title="Scenarios"
      description="Conservative, base and optimistic assumptions — the same plan looked at through three different lenses."
    >
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="py-1">Scenario</th>
            <th className="py-1">Completion Date</th>
            <th className="py-1">Required Contribution</th>
            <th className="py-1">Target-Date Result</th>
          </tr>
        </thead>
        <tbody>
          {order.map((code) => {
            const f = forecasts[code];
            return (
              <tr key={code} className={`border-t ${code === 'base' ? 'font-medium' : ''}`}>
                <td className="py-1">{SCENARIO_LABEL[code]}</td>
                <td className="py-1">
                  {f.projectedCompletionDate
                    ? new Date(f.projectedCompletionDate).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })
                    : '—'}
                </td>
                <td className="py-1">
                  {f.requiredMonthlyContribution !== null ? formatMoney(f.requiredMonthlyContribution, currency) : '—'}
                </td>
                <td className="py-1">{f.forecastFundingPct !== null ? `${f.forecastFundingPct.toFixed(0)}%` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-gray-400">
        Based on the assumptions shown for each scenario — these are estimates, not guarantees.
      </p>
    </SectionCard>
  );
}
