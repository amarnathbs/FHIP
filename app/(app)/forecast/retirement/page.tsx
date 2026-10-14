import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { loadDashboard } from '@/lib/services/dashboardData';
import { resolveForecastPageContext } from '@/lib/services/forecastData';
import { RetirementForecastPanel } from '@/components/forecast/RetirementForecastPanel';
import { RetirementTimingSettings } from '@/components/forecast/RetirementTimingSettings';
import { ScenarioSwitcher } from '@/components/forecast/ScenarioSwitcher';

async function ForecastRetirementPageContent({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [summary, { scenarios, activeScenario, profile }] = await Promise.all([
    loadDashboard(user.id, supabase),
    resolveForecastPageContext(user.id, scenario, supabase),
  ]);

  return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Retirement Forecast</h1>
            <p className="mt-1 text-muted">Retirement readiness projection for the selected scenario.</p>
          </div>
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenario.id} />
        </div>
        <RetirementTimingSettings
          initialRetirementDate={profile.retirement_date ?? null}
          initialOverrideMonths={profile.retirement_timing_override_months ?? null}
        />
        <RetirementForecastPanel currency={summary.currency} currentBalance={summary.totalRetirement} scenarioId={activeScenario.id} />
      </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Forecasting).
export default function ForecastRetirementPage(props: Parameters<typeof ForecastRetirementPageContent>[0]) {
  return (
    <>
      <PageBackLink href="/forecast" label="Forecasting" />
      <ForecastRetirementPageContent {...props} />
    </>
  );
}
