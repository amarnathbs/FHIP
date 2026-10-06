import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { loadDashboard } from '@/lib/services/dashboardData';
import { resolveForecastPageContext } from '@/lib/services/forecastData';
import { CrossBorderForecastPanel } from '@/components/forecast/CrossBorderForecastPanel';
import { ScenarioSwitcher } from '@/components/forecast/ScenarioSwitcher';

async function ForecastCrossBorderPageContent({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
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
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Cross-Border Forecast</h1>
            <p className="mt-1 text-muted">Foreign-currency wealth projection, converted to your reporting currency, for the selected scenario.</p>
          </div>
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenario.id} />
        </div>
        <CrossBorderForecastPanel currency={summary.currency} scenarioId={activeScenario.id} />
      </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Forecasting).
export default function ForecastCrossBorderPage(props: Parameters<typeof ForecastCrossBorderPageContent>[0]) {
  return (
    <>
      <PageBackLink href="/forecast" label="Forecasting" />
      <ForecastCrossBorderPageContent {...props} />
    </>
  );
}
