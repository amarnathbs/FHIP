import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { loadDashboard } from '@/lib/services/dashboardData';
import { resolveForecastPageContext, listForecastRuns, getForecastRunDetail } from '@/lib/services/forecastData';
import { RunForecastPanel } from '@/components/forecast/RunForecastPanel';
import { ScenarioSwitcher } from '@/components/forecast/ScenarioSwitcher';

export default async function ForecastNetWorthPage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [summary, { scenarios, activeScenario }] = await Promise.all([
    loadDashboard(user.id, supabase),
    resolveForecastPageContext(user.id, scenario, supabase),
  ]);

  const runs = await listForecastRuns(user.id, activeScenario.forecast_profile_id, supabase);
  const latestCompleted = runs.find((r) => r.forecast_type === 'net_worth' && r.status === 'completed' && r.scenario_id === activeScenario.id);
  const initialDetail = latestCompleted ? await getForecastRunDetail(user.id, latestCompleted.id, supabase) : null;
  const currentNetWorth = summary.totalAssets + summary.totalInvestments + summary.totalRetirement - summary.totalLiabilities;

  return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Net Worth Forecast</h1>
            <p className="mt-1 text-muted">Deterministic monthly net worth projection for the selected scenario.</p>
          </div>
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenario.id} />
        </div>
        <RunForecastPanel currency={summary.currency} currentNetWorth={currentNetWorth} initialDetail={initialDetail} scenarioId={activeScenario.id} />
      </div>
  );
}
