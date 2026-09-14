import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { getOrCreateForecastProfile, listScenarios, createScenario } from '@/lib/services/forecastData';
import { forecastScenarioSchema } from '@/lib/validation/forecast';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const profile = await getOrCreateForecastProfile(user.id);
    const scenarios = await listScenarios(user.id, profile.id);
    return ok({ profile, scenarios });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load scenarios');
  }
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = forecastScenarioSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  try {
    const profile = await getOrCreateForecastProfile(user.id);
    const scenario = await createScenario(user.id, profile.id, parsed.data);
    return ok(scenario);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not create scenario');
  }
}
