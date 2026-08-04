import { formatMoney } from '@/lib/engines/money';
import type { GoalSummary } from '@/lib/services/goalsData';
import type { AffordabilityResult } from '@/lib/engines/goalAffordability';

export function GoalsSummaryHero({
  summary,
  affordability,
  currency,
}: {
  summary: GoalSummary;
  affordability: AffordabilityResult;
  currency: 'AUD' | 'INR';
}) {
  return (
    <div className="rounded-card border bg-white p-8">
      <p className="text-sm font-medium uppercase tracking-wide text-gray-400">Goal Planning™</p>
      <h1 className="mt-2 text-2xl font-bold text-trust">
        You have {summary.activeGoalsCount} active goal{summary.activeGoalsCount === 1 ? '' : 's'}
      </h1>
      <p className="mt-2 text-gray-600">
        {summary.onTrackCount} on track, {summary.atRiskCount} at risk and {summary.offTrackCount} off track.
        {affordability.monthlySurplus !== null && (
          <>
            {' '}
            You have allocated {formatMoney(summary.totalMonthlyContribution, currency)} of your estimated{' '}
            {formatMoney(affordability.monthlySurplus, currency)} monthly surplus.
          </>
        )}
      </p>
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <p className="text-xs text-gray-500">Combined target</p>
          <p className="text-lg font-semibold text-gray-900">{formatMoney(summary.totalTargetAmount, currency)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Currently funded</p>
          <p className="text-lg font-semibold text-gray-900">{formatMoney(summary.totalCurrentAmount, currency)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Overall progress</p>
          <p className="text-lg font-semibold text-gray-900">{Math.min(100, summary.overallProgressPct).toFixed(1)}%</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Monthly allocation</p>
          <p className="text-lg font-semibold text-gray-900">{formatMoney(summary.totalMonthlyContribution, currency)}</p>
        </div>
      </div>
      <p className="mt-4 text-xs text-gray-400">
        This combined percentage is shown for information only — a large long-term goal doesn&apos;t obscure the status
        of your smaller, more urgent goals below.
      </p>
    </div>
  );
}
