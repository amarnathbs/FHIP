import Link from 'next/link';
import { formatMoney } from '@/lib/engines/money';
import type { GoalPayload } from '@/lib/services/goalsData';
import { ContextualExplain } from '@/components/aiExplain/ContextualExplain';

// The same two certified track statuses AIStandardQuestionService treats as
// "off track" for SQ-AI-021 (its AT_RISK_STATUSES). Kept identical so the
// control is offered exactly when the server would answer it.
const AT_RISK_TRACK_STATUSES = new Set(['at_risk', 'off_track']);

const TRACK_LABEL: Record<string, string> = {
  ahead_of_track: 'Ahead of Track',
  on_track: 'On Track',
  at_risk: 'At Risk',
  off_track: 'Off Track',
  fully_funded: 'Fully Funded',
  unable_to_assess: 'Unable to Assess',
};

const TRACK_COLOR: Record<string, string> = {
  ahead_of_track: '#0F6B41',
  on_track: '#198754',
  at_risk: '#B7791F',
  off_track: '#C7362F',
  fully_funded: '#2563EB',
  unable_to_assess: '#9CA3AF',
};

export function GoalCard({ goal, currency }: { goal: GoalPayload; currency: 'AUD' | 'INR' }) {
  const forecast = goal.forecasts.base;
  const displayProgress = Math.min(100, forecast.progressPct);
  const trackColor = TRACK_COLOR[forecast.trackStatus] ?? TRACK_COLOR.unable_to_assess;
  const nextMilestone = goal.milestones
    .filter((m) => m.status === 'pending')
    .sort((a, b) => a.display_order - b.display_order)[0];

  return (
    <div className="rounded-card border bg-white p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-semibold text-gray-900">{goal.goalName}</p>
          <p className="text-xs text-gray-500">
            {goal.goalType.replace(/_/g, ' ')} · {goal.countryCode ?? '—'} · {goal.currencyCode}
          </p>
        </div>
        <span className="rounded-full px-2 py-0.5 text-xs font-semibold text-white" style={{ background: trackColor }}>
          {TRACK_LABEL[forecast.trackStatus] ?? forecast.trackStatus}
        </span>
      </div>

      <div className="mt-3">
        <div className="flex justify-between text-xs text-gray-500">
          <span>{formatMoney(goal.currentAmount, currency)}</span>
          <span>{formatMoney(forecast.targetAmountFuture, currency)}</span>
        </div>
        <div className="mt-1 h-2 w-full rounded-full bg-gray-100">
          <div className="h-2 rounded-full bg-trust" style={{ width: `${displayProgress}%` }} />
        </div>
        <p className="mt-1 text-xs text-gray-500">{displayProgress.toFixed(0)}% funded</p>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-gray-500">Monthly contribution</p>
          <p className="font-medium text-gray-900">{formatMoney(goal.plannedContributionAmount, currency)}</p>
        </div>
        <div>
          <p className="text-gray-500">Required contribution</p>
          <p className="font-medium text-gray-900">
            {forecast.requiredMonthlyContribution !== null ? formatMoney(forecast.requiredMonthlyContribution, currency) : '—'}
          </p>
        </div>
        <div>
          <p className="text-gray-500">Target date</p>
          <p className="font-medium text-gray-900">
            {goal.targetDate ? new Date(goal.targetDate).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }) : '—'}
          </p>
        </div>
        <div>
          <p className="text-gray-500">Forecast completion</p>
          <p className="font-medium text-gray-900">
            {forecast.projectedCompletionDate
              ? new Date(forecast.projectedCompletionDate).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })
              : '—'}
          </p>
        </div>
      </div>

      {nextMilestone && (
        <p className="mt-3 text-xs text-gray-500">
          Next milestone: <span className="font-medium text-gray-700">{nextMilestone.milestone_name}</span> (
          {formatMoney(nextMilestone.target_amount, currency)})
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link href={`/goals/${goal.id}`} className="inline-block text-xs font-medium text-trust hover:underline">
          View details →
        </Link>
        {/* Module 11.5 (spec sections 36-38). Rendered ONLY for a goal that is
            genuinely at risk / off track: spec section 38 is explicit that an
            on-track goal must not be shown an off-track explanation, so rather
            than offering a control that would resolve to "not applicable", the
            control is simply not offered. The server enforces the same rule
            independently — SQ-AI-021 only ever matches the caller's own
            off-track goals — so hiding it here is UX, not the security
            boundary. The accessible name identifies WHICH goal (section 68). */}
        {AT_RISK_TRACK_STATUSES.has(forecast.trackStatus) && (
          <ContextualExplain
            targetCode="GOAL_STATUS"
            targetId={goal.id}
            accessibleLabel={`Explain status for ${goal.goalName} goal`}
            className="inline-flex min-h-[32px] items-center gap-1 text-xs font-medium text-ai hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ai focus-visible:ring-offset-1"
          />
        )}
      </div>
    </div>
  );
}
