import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { resolveForecastPageContext } from '@/lib/services/forecastData';
import { EntityForecastPanel } from '@/components/forecast/EntityForecastPanel';
import { ScenarioSwitcher } from '@/components/forecast/ScenarioSwitcher';

export default async function ForecastGoalsPage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [goalsResult, { scenarios, activeScenario }] = await Promise.all([
    supabase.from('user_goals').select('id, goal_name, currency_code').eq('user_id', user.id).eq('status', 'active'),
    resolveForecastPageContext(user.id, scenario, supabase),
  ]);
  const goalEntities = (goalsResult.data ?? []).map((g) => ({ id: g.id, name: g.goal_name, currency: g.currency_code as 'AUD' | 'INR' }));

  return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Goal Forecasts</h1>
            <p className="mt-1 text-muted">
              Projected completion date and required monthly contribution for each active goal, for the selected scenario. Goal-to-investment
              tagging and allocation are managed on the{' '}
              <a href="/goals" className="text-trust underline">
                Financial Goals
              </a>{' '}
              page.
            </p>
          </div>
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenario.id} />
        </div>
        <EntityForecastPanel
          title="Goal Forecasts"
          description="Projected completion date and required monthly contribution for each active goal."
          forecastType="goal"
          emptyMessage="No active goals yet — create one on the Financial Goals page."
          entities={goalEntities}
          scenarioId={activeScenario.id}
        />
      </div>
  );
}
