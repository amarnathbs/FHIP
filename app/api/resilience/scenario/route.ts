import { ok, bad } from '@/lib/api';
import { requireModuleCapability } from '@/lib/services/appCapability';
import { createClient } from '@/lib/supabase/server';
import { buildResilienceInput } from '@/lib/services/resilienceData';
import { computeResilience } from '@/lib/engines/resilience';
import { getUserHomeCountry } from '@/lib/services/jurisdiction';
import {
  applyStressScenario,
  STRESS_SCENARIO_LABELS,
  type StressScenarioType,
  type StressScenarioParams,
} from '@/lib/engines/resilienceStress';

const VALID_SCENARIOS = Object.keys(STRESS_SCENARIO_LABELS) as StressScenarioType[];

// A simulated result only — never persisted, mirroring the Module 4/5
// what-if simulators (lib/engines/whatIf.ts).
export async function POST(req: Request) {
  // G4 closure item 2: "A simulated result only — never persisted" (see this
  // route's own comment above), so this is classified VIEW rather than the
  // POST-method default of CREATE — forcing it into the not-yet-certified
  // write bucket would over-restrict a GENERIC user for no safety benefit.
  const { user, blocked } = await requireModuleCapability('RESILIENCE', req, { operation: 'VIEW' });
  if (!user) return blocked!;
  const body = await req.json().catch(() => null);
  const scenario = body?.scenario as StressScenarioType | undefined;
  if (!scenario || !VALID_SCENARIOS.includes(scenario)) return bad('invalid scenario', 422);
  const params = (body?.params ?? {}) as StressScenarioParams;

  const supabase = await createClient();
  // G0-JA-1 Wave 1 (JA-D2): the caller's own already-resolved home country,
  // via the canonical resolver — never re-derived from currency (the defect
  // this replaces). buildResilienceInput() still creates its own client
  // internally (unchanged, per the rollback boundary), so this is an
  // additional, independent read, not a re-use of a shared request-scoped
  // client.
  const [baseInput, homeCountry] = await Promise.all([buildResilienceInput(user.id), getUserHomeCountry(user.id, supabase)]);
  const baseResult = computeResilience(baseInput);

  const stress = applyStressScenario(baseInput.dashboard, scenario, baseInput.commitments, params, homeCountry);
  const shockedResult = computeResilience({ ...baseInput, dashboard: stress.shockedDashboard });

  return ok({
    scenario,
    label: STRESS_SCENARIO_LABELS[scenario],
    before: {
      overallScore: Math.round(baseResult.overallScore * 10) / 10,
      statusLabel: baseResult.statusLabel,
      monthlySurplus: stress.before.monthlySurplus,
      accessibleLiquidResources: stress.before.accessibleLiquidResources,
    },
    after: {
      overallScore: Math.round(shockedResult.overallScore * 10) / 10,
      statusLabel: shockedResult.statusLabel,
      monthlySurplus: stress.after.monthlySurplus,
      accessibleLiquidResources: stress.after.accessibleLiquidResources,
    },
    monthlyShortfall: stress.monthlyShortfall,
    survivalMonths: stress.survivalMonths,
    durationMonths: stress.durationMonths,
  });
}
