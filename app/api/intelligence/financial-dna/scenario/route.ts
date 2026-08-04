import { requireUser, ok, bad } from '@/lib/api';
import { buildDnaInput } from '@/lib/services/financialDnaData';
import { classifyFinancialDna } from '@/lib/engines/financialDna';
import { applyScenario, type ScenarioType } from '@/lib/engines/whatIf';

const VALID_SCENARIOS: ScenarioType[] = [
  'increase_savings',
  'pay_off_debt',
  'build_emergency_fund',
  'reduce_lifestyle_expenses',
  'lose_income',
];

function summarise(result: ReturnType<typeof classifyFinancialDna>) {
  return {
    primaryProfileCode: result.primaryProfileCode,
    primaryScore: result.primaryScore,
    confidence: result.confidence,
  };
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => null);
  const scenario = body?.scenario as ScenarioType | undefined;
  if (!scenario || !VALID_SCENARIOS.includes(scenario)) return bad('invalid scenario', 422);

  const baseInput = await buildDnaInput(user.id);
  const baseResult = classifyFinancialDna(baseInput);

  const scenarioDashboard = applyScenario(baseInput.dashboard, scenario);
  const scenarioInput = { ...baseInput, dashboard: scenarioDashboard };
  const scenarioResult = classifyFinancialDna(scenarioInput);

  // A simulated result only — never persisted unless the user changes their actual data.
  return ok({ before: summarise(baseResult), after: summarise(scenarioResult) });
}
