import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { loadDashboard } from '@/lib/services/dashboardData';
import { resolveForecastPageContext, listForecastRuns, getForecastRunDetail, getNetWorthVariance } from '@/lib/services/forecastData';
import { RunForecastPanel } from '@/components/forecast/RunForecastPanel';
import { NetWorthVarianceCard } from '@/components/forecast/NetWorthVarianceCard';
import { ScenarioComparisonPanel } from '@/components/forecast/ScenarioComparisonPanel';
import { ScenarioSwitcher } from '@/components/forecast/ScenarioSwitcher';

export default async function ForecastOverviewPage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [summary, { profile, scenarios, activeScenario }] = await Promise.all([
    loadDashboard(user.id, supabase),
    resolveForecastPageContext(user.id, scenario, supabase),
  ]);

  const runs = await listForecastRuns(user.id, profile.id, supabase);
  const latestCompleted = runs.find((r) => r.forecast_type === 'net_worth' && r.status === 'completed' && r.scenario_id === activeScenario.id);
  const [initialDetail, variance] = await Promise.all([
    latestCompleted ? getForecastRunDetail(user.id, latestCompleted.id, supabase) : null,
    getNetWorthVariance(user.id, profile.id, activeScenario.id, supabase),
  ]);

  const currentNetWorth = summary.totalAssets + summary.totalInvestments + summary.totalRetirement - summary.totalLiabilities;

  return (
    <AppShell>
      <div className="space-y-6" data-testid="forecast-overview">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Forecast Overview</h1>
            <p className="mt-1 text-muted">
              Deterministic monthly projections of your future financial position. Net worth, goal, investment, debt, retirement,
              cross-border and resilience forecasts are on their own pages under Forecasting — this page tracks net worth,
              variance against your original forecast, and scenario comparison.
            </p>
          </div>
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenario.id} />
        </div>
        <RunForecastPanel currency={summary.currency} currentNetWorth={currentNetWorth} initialDetail={initialDetail} scenarioId={activeScenario.id} />
        <NetWorthVarianceCard variance={variance} currency={summary.currency} />
        <ScenarioComparisonPanel currency={summary.currency} />
      </div>
    </AppShell>
  );
}
