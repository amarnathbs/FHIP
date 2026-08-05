import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { resolveForecastPageContext } from '@/lib/services/forecastData';
import { EntityForecastPanel } from '@/components/forecast/EntityForecastPanel';
import { ScenarioSwitcher } from '@/components/forecast/ScenarioSwitcher';

export default async function ForecastInvestmentsPage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [investmentsResult, { scenarios, activeScenario }] = await Promise.all([
    supabase.from('investments').select('id, investment_name, currency_code').eq('user_id', user.id).eq('is_active', true),
    resolveForecastPageContext(user.id, scenario, supabase),
  ]);
  const investmentEntities = (investmentsResult.data ?? []).map((inv) => ({
    id: inv.id,
    name: inv.investment_name,
    currency: inv.currency_code as 'AUD' | 'INR',
  }));

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Investment Growth Forecast</h1>
            <p className="mt-1 text-muted">Projected growth for each investment account, for the selected scenario.</p>
          </div>
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenario.id} />
        </div>
        <EntityForecastPanel
          title="Investment Forecasts"
          description="Projected growth for each investment account, using its assumed return and regular contribution."
          forecastType="investment"
          emptyMessage="No active investments yet — add one on the Investments page."
          entities={investmentEntities}
          scenarioId={activeScenario.id}
        />
      </div>
    </AppShell>
  );
}
