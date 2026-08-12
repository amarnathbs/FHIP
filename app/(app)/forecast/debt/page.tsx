import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { resolveForecastPageContext } from '@/lib/services/forecastData';
import { DebtForecastPanel } from '@/components/forecast/DebtForecastPanel';
import { ScenarioSwitcher } from '@/components/forecast/ScenarioSwitcher';

export default async function ForecastDebtPage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [liabilitiesResult, { scenarios, activeScenario }] = await Promise.all([
    supabase.from('liabilities').select('id, liability_name, currency_code').eq('user_id', user.id).eq('is_active', true),
    resolveForecastPageContext(user.id, scenario, supabase),
  ]);
  const liabilityEntities = (liabilitiesResult.data ?? []).map((l) => ({ id: l.id, name: l.liability_name, currency: l.currency_code as 'AUD' | 'INR' }));

  return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Debt Reduction Forecast</h1>
            <p className="mt-1 text-muted">Projected payoff date and total interest for each liability, for the selected scenario.</p>
          </div>
          <ScenarioSwitcher scenarios={scenarios} activeScenarioId={activeScenario.id} />
        </div>
        <DebtForecastPanel liabilities={liabilityEntities} scenarioId={activeScenario.id} />
      </div>
  );
}
