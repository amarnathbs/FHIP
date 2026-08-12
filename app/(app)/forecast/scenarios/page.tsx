import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { getOrCreateForecastProfile, ensureDefaultScenario, listScenarios, getResolvedAssumptions } from '@/lib/services/forecastData';
import { diffScenarioAssumptions, isScenarioConfigured, summarizeWhatChanged } from '@/lib/engines/forecast/scenarioDiff';
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

  // Forecasting P1 fix FHIP-FC-SCN-001/002 — flag scenarios that don't
  // actually differ from Base (silently forecast identically otherwise) and
  // summarize what does differ for scenarios that do.
  const baseScenario = scenarios.find((s) => s.scenario_type === 'base') ?? scenarios.find((s) => s.is_default) ?? null;
  const baseAssumptions = baseScenario ? await getResolvedAssumptions(user.id, profile.id, baseScenario.id, supabase) : {};
  const scenariosWithDiff = await Promise.all(
    scenarios.map(async (s) => {
      if (!baseScenario || s.id === baseScenario.id) return { ...s, isConfigured: true, whatChanged: null as string | null };
      const candidateAssumptions = await getResolvedAssumptions(user.id, profile.id, s.id, supabase);
      const diffs = diffScenarioAssumptions(baseAssumptions, candidateAssumptions);
      return { ...s, isConfigured: isScenarioConfigured(diffs), whatChanged: summarizeWhatChanged(diffs) };
    })
  );

  return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-trust">Forecast Scenarios</h1>
          <p className="mt-1 text-muted">
            Every forecast runs against a scenario. Add conservative, optimistic or stress scenarios to compare outcomes — a
            scenario with no assumption overrides is flagged &quot;Not configured&quot; below, since it forecasts identically
            to Base until you set at least one override on the Assumptions page.
          </p>
        </div>
        <SectionCard title="Scenarios">
          <ScenarioManager initialScenarios={scenariosWithDiff} />
        </SectionCard>
      </div>
  );
}
