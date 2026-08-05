import { formatMoney } from '@/lib/engines/money';
import type { GoalPayload } from '@/lib/services/goalsData';

const STATUS_CONFIG = [
  { key: 'on_track', label: 'On Track', color: '#198754', codes: ['on_track', 'ahead_of_track'] },
  { key: 'at_risk', label: 'At Risk', color: '#B7791F', codes: ['at_risk'] },
  { key: 'off_track', label: 'Off Track', color: '#C7362F', codes: ['off_track'] },
  { key: 'achieved', label: 'Achieved', color: '#2563EB', codes: ['fully_funded'] },
] as const;

export function GoalStatusSummary({ goals, currency }: { goals: GoalPayload[]; currency: 'AUD' | 'INR' }) {
  const active = goals.filter((g) => g.status === 'active');
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {STATUS_CONFIG.map((s) => {
        const matching =
          s.key === 'achieved'
            ? goals.filter((g) => g.status === 'achieved' || g.forecasts.base.trackStatus === 'fully_funded')
            : active.filter((g) => (s.codes as readonly string[]).includes(g.forecasts.base.trackStatus));
        const combinedTarget = matching.reduce((sum, g) => sum + g.forecasts.base.targetAmountFuture, 0);
        const combinedGap = matching.reduce((sum, g) => sum + (g.forecasts.base.fundingGapAtTargetDate ?? 0), 0);
        const monthlyAllocated = matching.reduce((sum, g) => sum + g.plannedContributionAmount, 0);
        const nearestDate = matching
          .filter((g) => g.targetDate)
          .sort((a, b) => (a.targetDate! < b.targetDate! ? -1 : 1))[0]?.targetDate;
        return (
          <div key={s.key} className="rounded-card border bg-white p-4" style={{ borderTopWidth: 3, borderTopColor: s.color }}>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{s.label}</p>
            <p className="mt-1 text-2xl font-bold text-gray-900">{matching.length}</p>
            <div className="mt-2 space-y-1 text-xs text-gray-500">
              <p>Combined target: {formatMoney(combinedTarget, currency)}</p>
              {s.key !== 'achieved' && <p>Funding gap: {formatMoney(combinedGap, currency)}</p>}
              <p>Monthly allocated: {formatMoney(monthlyAllocated, currency)}</p>
              {nearestDate && <p>Nearest date: {new Date(nearestDate).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
