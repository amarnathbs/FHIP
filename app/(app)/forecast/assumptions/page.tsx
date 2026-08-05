import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { getOrCreateForecastProfile, ensureDefaultScenario, getResolvedAssumptions } from '@/lib/services/forecastData';
import { AssumptionsTable } from '@/components/forecast/AssumptionsTable';

export default async function ForecastAssumptionsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const profile = await getOrCreateForecastProfile(user.id, supabase);
  const scenario = await ensureDefaultScenario(user.id, profile.id, supabase);
  const assumptions = await getResolvedAssumptions(user.id, profile.id, scenario.id, supabase);
  const rows = Object.values(assumptions)
    .map((a) => ({ key: a.key, category: a.category, value: a.value, valueType: a.valueType, unit: a.unit, sourceType: a.sourceType }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-trust">Forecast Assumptions</h1>
          <p className="mt-1 text-muted">
            Every projection is built on these editable assumptions. Country and platform defaults apply until you override
            one — overrides are visible everywhere they&apos;re used, per assumption.
          </p>
        </div>
        <SectionCard title="Assumptions" description={`Base currency: ${profile.base_currency} · Country: ${profile.country_code ?? '—'}`}>
          <AssumptionsTable initialAssumptions={rows} scenarioId={scenario.scenario_name} />
        </SectionCard>
      </div>
    </AppShell>
  );
}
