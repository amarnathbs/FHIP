import { requireUser, ok, bad } from '@/lib/api';
import { buildResilienceInput } from '@/lib/services/resilienceData';
import { computeResilience } from '@/lib/engines/resilience';
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
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => null);
  const scenario = body?.scenario as StressScenarioType | undefined;
  if (!scenario || !VALID_SCENARIOS.includes(scenario)) return bad('invalid scenario', 422);
  const params = (body?.params ?? {}) as StressScenarioParams;

  const baseInput = await buildResilienceInput(user.id);
  const baseResult = computeResilience(baseInput);

  const stress = applyStressScenario(baseInput.dashboard, scenario, baseInput.commitments, params);
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
