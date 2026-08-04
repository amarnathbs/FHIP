import Link from 'next/link';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import type { GoalSummary } from '@/lib/services/goalsData';

export function DashboardGoalsCard({ summary, currency }: { summary: GoalSummary; currency: 'AUD' | 'INR' }) {
  if (summary.activeGoalsCount === 0) {
    return (
      <SectionCard title="Financial Goals">
        <p className="text-sm text-gray-500">No active goals yet.</p>
        <Link href="/goals/new" className="mt-2 inline-block text-xs font-medium text-trust hover:underline">
          Create your first goal →
        </Link>
      </SectionCard>
    );
  }
  return (
    <SectionCard title="Financial Goals">
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-gray-500">Active goals</p>
          <p className="font-semibold text-gray-900">{summary.activeGoalsCount}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">On track</p>
          <p className="font-semibold text-progress">{summary.onTrackCount}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">At risk</p>
          <p className="font-semibold text-caution">{summary.atRiskCount}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Off track</p>
          <p className="font-semibold text-risk">{summary.offTrackCount}</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-gray-500">Monthly allocation: {formatMoney(summary.totalMonthlyContribution, currency)}</p>
      {summary.nextGoalDue && (
        <p className="mt-1 text-xs text-gray-500">
          Next target: {summary.nextGoalDue.goalName} —{' '}
          {new Date(summary.nextGoalDue.targetDate).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}
        </p>
      )}
      <Link href="/goals" className="mt-3 inline-block text-xs font-medium text-trust hover:underline">
        View all goals →
      </Link>
    </SectionCard>
  );
}
