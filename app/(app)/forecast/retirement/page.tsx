import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { loadDashboard } from '@/lib/services/dashboardData';
import { resolveForecastPageContext } from '@/lib/services/forecastData';
import { RetirementForecastPanel } from '@/components/forecast/RetirementForecastPanel';
import { ScenarioSwitcher } from '@/components/forecast/ScenarioSwitcher';

export default async function ForecastRetirementPage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
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
            <h1 className="text-2xl font-semibold text-trust">Retirement Forecast</h1>
            <p className="mt-1 text-gray-500">Retirement readiness projection for the selected scenario.</p>
          </div>
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenario.id} />
        </div>
        <RetirementForecastPanel currency={summary.currency} currentBalance={summary.totalRetirement} scenarioId={activeScenario.id} />
      </div>
    </AppShell>
  );
}
