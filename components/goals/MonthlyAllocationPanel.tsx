import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import type { GoalPayload } from '@/lib/services/goalsData';
import type { AffordabilityResult } from '@/lib/engines/goalAffordability';

const STATUS_COPY: Record<string, { label: string; color: string }> = {
  comfortable: { label: 'Comfortable', color: '#0B6E4F' },
  manageable: { label: 'Manageable', color: '#0E9F8E' },
  tight: { label: 'Tight', color: '#D98A00' },
  overallocated: { label: 'Overallocated', color: '#C0392B' },
  deficit: { label: 'Deficit', color: '#C0392B' },
  insufficient_data: { label: 'Insufficient data', color: '#9CA3AF' },
};

export function MonthlyAllocationPanel({
  goals,
  affordability,
  currency,
}: {
  goals: GoalPayload[];
  affordability: AffordabilityResult;
  currency: 'AUD' | 'INR';
}) {
  const active = goals.filter((g) => g.status === 'active');
  const statusInfo = STATUS_COPY[affordability.status];

  return (
    <SectionCard
      title="Monthly Goal Allocation"
      description="How your planned goal contributions compare with your estimated household surplus."
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="rounded-full px-3 py-1 text-xs font-semibold text-white" style={{ background: statusInfo.color }}>
          {statusInfo.label}
        </span>
        {affordability.warning && <p className="text-sm text-gray-600">{affordability.warning}</p>}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <p className="text-xs text-gray-500">Available surplus</p>
          <p className="text-sm font-semibold text-gray-900">
            {affordability.monthlySurplus !== null ? formatMoney(affordability.monthlySurplus, currency) : '—'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Allocated to goals</p>
          <p className="text-sm font-semibold text-gray-900">{formatMoney(affordability.totalPlannedGoalContributions, currency)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Unallocated</p>
          <p className="text-sm font-semibold text-gray-900">
            {affordability.unallocatedAmount !== null ? formatMoney(affordability.unallocatedAmount, currency) : '—'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Overallocated</p>
          <p className="text-sm font-semibold text-risk">
            {affordability.overallocatedAmount ? formatMoney(affordability.overallocatedAmount, currency) : '—'}
          </p>
        </div>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="py-1">Goal</th>
            <th className="py-1">Planned</th>
            <th className="py-1">Required</th>
            <th className="py-1">Difference</th>
          </tr>
        </thead>
        <tbody>
          {active.map((g) => {
            const required = g.forecasts.base.requiredMonthlyContribution;
            const diff = required !== null ? g.plannedContributionAmount - required : null;
            return (
              <tr key={g.id} className="border-t">
                <td className="py-1">{g.goalName}</td>
                <td className="py-1">{formatMoney(g.plannedContributionAmount, currency)}</td>
                <td className="py-1">{required !== null ? formatMoney(required, currency) : '—'}</td>
                <td className={`py-1 font-medium ${diff !== null && diff < 0 ? 'text-risk' : 'text-progress'}`}>
                  {diff !== null ? `${diff >= 0 ? '+' : ''}${formatMoney(diff, currency)}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </SectionCard>
  );
}
