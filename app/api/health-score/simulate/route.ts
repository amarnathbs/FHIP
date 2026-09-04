import { ok, bad } from '@/lib/api';
import { requireModuleCapability } from '@/lib/services/appCapability';
import { buildHealthScoreInput } from '@/lib/services/healthScoreData';
import { computeHealthScore } from '@/lib/engines/healthScore';
import { applyScenario, type ScenarioType } from '@/lib/engines/whatIf';

const VALID_SCENARIOS: ScenarioType[] = [
  'increase_savings',
  'pay_off_debt',
  'build_emergency_fund',
  'reduce_lifestyle_expenses',
  'lose_income',
];

function summarise(input: Awaited<ReturnType<typeof buildHealthScoreInput>>, score: number) {
  const d = input.dashboard;
  return {
    score: Math.round(score * 10) / 10,
    savingsRate: d.savingsRate,
    debtServiceRatio: d.debtServiceRatio,
    emergencyFundMonths: d.emergencyFundMonths,
    monthlySurplus: d.monthlySurplus,
  };
}

export async function POST(req: Request) {
  const { user, blocked } = await requireModuleCapability('SCORES', req);
  if (!user) return blocked!;
  const body = await req.json().catch(() => null);
  const scenario = body?.scenario as ScenarioType | undefined;
  if (!scenario || !VALID_SCENARIOS.includes(scenario)) return bad('invalid scenario', 422);

  const baseInput = await buildHealthScoreInput(user.id);
  const baseResult = computeHealthScore(baseInput);

  const scenarioDashboard = applyScenario(baseInput.dashboard, scenario);
  const scenarioInput = { ...baseInput, dashboard: scenarioDashboard };
  const scenarioResult = computeHealthScore(scenarioInput);

  return ok({
    before: summarise(baseInput, baseResult.overallScore),
    after: summarise(scenarioInput, scenarioResult.overallScore),
  });
}
