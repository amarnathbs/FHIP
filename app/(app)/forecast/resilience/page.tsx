import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { loadDashboard } from '@/lib/services/dashboardData';
import { resolveForecastPageContext } from '@/lib/services/forecastData';
import { ResilienceForecastPanel } from '@/components/forecast/ResilienceForecastPanel';
import { ScenarioSwitcher } from '@/components/forecast/ScenarioSwitcher';

export default async function ForecastResiliencePage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
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

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Financial Resilience Forecast</h1>
            <p className="mt-1 text-gray-500">How your financial security develops over time, optionally under a stress scenario.</p>
          </div>
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenario.id} />
        </div>
        <ResilienceForecastPanel currency={summary.currency} scenarioId={activeScenario.id} />
      </div>
    </AppShell>
  );
}
