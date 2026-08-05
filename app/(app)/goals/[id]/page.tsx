import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import { loadGoalDetail } from '@/lib/services/goalsData';
import { ScenarioTable } from '@/components/goals/ScenarioTable';
import { FundingSourceList } from '@/components/goals/FundingSourceList';
import { ContributionHistory } from '@/components/goals/ContributionHistory';
import { MilestoneTracker } from '@/components/goals/MilestoneTracker';
import { GoalWhatIfSimulator } from '@/components/goals/GoalWhatIfSimulator';

export default async function GoalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const detail = await loadGoalDetail(user.id, id);
  if (!detail) notFound();

  const { goal, contributions } = detail;
  const currency = goal.currencyCode;
  const base = goal.forecasts.base;
  const displayProgress = Math.min(100, base.progressPct);

  return (
    <AppShell>
      <div className="space-y-8">
        <div>
          <Link href="/goals" className="text-xs text-muted hover:underline">
            ← Back to Goals
          </Link>
          <div className="mt-2 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-trust">{goal.goalName}</h1>
              <p className="text-muted">
                {goal.goalType.replace(/_/g, ' ')} · {goal.countryCode ?? '—'} · {goal.currencyCode} · Priority {goal.userPriority}/5
              </p>
            </div>
          </div>
        </div>

        <SectionCard title="Progress & Forecast">
          <div className="flex justify-between text-sm text-muted">
            <span>{formatMoney(goal.currentAmount, currency)}</span>
            <span>{formatMoney(base.targetAmountFuture, currency)}</span>
          </div>
          <div className="mt-1 h-3 w-full rounded-full bg-gray-100">
            <div className="h-3 rounded-full bg-trust" style={{ width: `${displayProgress}%` }} />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Progress" value={`${displayProgress.toFixed(0)}%`} />
            <Stat label="Funding gap" value={formatMoney(base.fundingGapAtTargetDate ?? 0, currency)} />
            <Stat
              label="Required contribution"
              value={base.requiredMonthlyContribution !== null ? formatMoney(base.requiredMonthlyContribution, currency) : '—'}
            />
            <Stat
              label="Forecast completion"
              value={
                base.projectedCompletionDate
                  ? new Date(base.projectedCompletionDate).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })
                  : '—'
              }
            />
          </div>
          <p className="mt-4 text-sm text-gray-600">{base.explanation}</p>
        </SectionCard>

        <ScenarioTable forecasts={goal.forecasts} currency={currency} />
        <FundingSourceList goalId={goal.id} initial={goal.fundingSources} currency={currency} />
        <ContributionHistory goalId={goal.id} initial={contributions} currency={currency} />
        <MilestoneTracker goalId={goal.id} initial={goal.milestones} currency={currency} />
        <GoalWhatIfSimulator goalId={goal.id} currentContribution={goal.plannedContributionAmount} currency={currency} />

        <details className="rounded-card border bg-white p-6">
          <summary className="cursor-pointer text-sm font-medium text-gray-800">Assumptions & methodology</summary>
          <div className="mt-3 space-y-2 text-sm text-gray-600">
            <p>
              Forecasts are calculated deterministically using the assumptions configured for this goal&apos;s category, and
              are never generated or altered by AI. Progress, funding gap, required contribution and completion date are
              estimates based on the assumptions shown — not a guarantee this goal will be achieved.
            </p>
            <p>Model version: goals-1.0.0</p>
          </div>
        </details>
      </div>
    </AppShell>
  );
}
