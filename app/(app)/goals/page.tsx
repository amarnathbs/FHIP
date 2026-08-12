import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { LockedFeatureCard } from '@/components/ui/LockedFeatureCard';
import { loadGoalsPage } from '@/lib/services/goalsData';
import { generateGoalInsights } from '@/lib/engines/goalInsights';
import { GoalsSummaryHero } from '@/components/goals/GoalsSummaryHero';
import { GoalStatusSummary } from '@/components/goals/GoalStatusSummary';
import { GoalCard } from '@/components/goals/GoalCard';
import { MonthlyAllocationPanel } from '@/components/goals/MonthlyAllocationPanel';
import { GoalTimeline } from '@/components/goals/GoalTimeline';
import { GoalInsights } from '@/components/goals/GoalInsights';

export default async function GoalsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('preferred_currency')
    .eq('user_id', user.id)
    .single();
  const currency = (profile?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  const payload = await loadGoalsPage(user.id);
  const activeGoals = payload.goals.filter((g) => g.status === 'active');
  const insights = generateGoalInsights(payload.goals, payload.summary, payload.affordability, currency);

  return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Financial Goals</h1>
            <p className="mt-1 text-muted">Turn your financial aspirations and obligations into measurable, trackable plans.</p>
          </div>
          <Link href="/goals/new" className="rounded bg-trust px-4 py-2 text-sm text-white">
            Create a goal
          </Link>
        </div>

        {payload.goals.length === 0 ? (
          <div className="rounded-card border border-dashed bg-gray-50 p-8 text-center">
            <p className="text-gray-700">Create your first goal to turn your financial information into a measurable plan.</p>
            <Link href="/goals/new" className="mt-4 inline-block rounded bg-trust px-4 py-2 text-sm text-white">
              Create your first goal
            </Link>
          </div>
        ) : (
          <>
            <GoalsSummaryHero summary={payload.summary} affordability={payload.affordability} currency={currency} />
            <GoalStatusSummary goals={payload.goals} currency={currency} />

            <div>
              <h2 className="mb-3 text-lg font-semibold text-gray-800">Active Goals</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {activeGoals.map((g) => (
                  <GoalCard key={g.id} goal={g} currency={currency} />
                ))}
              </div>
            </div>

            <MonthlyAllocationPanel goals={payload.goals} affordability={payload.affordability} currency={currency} />
            <GoalTimeline goals={payload.goals} currency={currency} />
            <GoalInsights insights={insights} />
          </>
        )}

        <div>
          <h2 className="mb-3 text-lg font-semibold text-gray-800">Coming up next</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <LockedFeatureCard
              title="Goal Dependencies"
              description="Sequence goals so one starts only once another is funded (e.g. build the emergency reserve before increasing travel funding). Kept as a placeholder for a fast-follow so it isn't forgotten."
            />
            <LockedFeatureCard
              title="Reminders & Notifications"
              description="Contribution reminders, review-due nudges, and at-risk alerts. Arrives once the platform's notification infrastructure is built."
            />
          </div>
        </div>
      </div>
  );
}
