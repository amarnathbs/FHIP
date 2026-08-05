import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { getOrCreateForecastProfile, ensureDefaultScenario, listScenarios } from '@/lib/services/forecastData';
import { ScenarioManager } from '@/components/forecast/ScenarioManager';

export default async function ForecastScenariosPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const profile = await getOrCreateForecastProfile(user.id, supabase);
  await ensureDefaultScenario(user.id, profile.id, supabase);
  const scenarios = await listScenarios(user.id, profile.id, supabase);

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-trust">Forecast Scenarios</h1>
          <p className="mt-1 text-muted">
            Every forecast runs against a scenario. Add conservative, optimistic or stress scenarios to compare outcomes —
            scenario-specific assumption overrides are coming in a later phase; for now each scenario uses your profile-level
            assumptions.
          </p>
        </div>
        <SectionCard title="Scenarios">
          <ScenarioManager initialScenarios={scenarios} />
        </SectionCard>
      </div>
    </AppShell>
  );
}
