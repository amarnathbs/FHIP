import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { getOrCreateForecastProfile, ensureDefaultScenario, getResolvedAssumptions, upsertUserAssumption } from '@/lib/services/forecastData';
import { forecastAssumptionUpsertSchema } from '@/lib/validation/forecast';

export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const profile = await getOrCreateForecastProfile(user.id);
    const url = new URL(req.url);
    const scenarioId = url.searchParams.get('scenario_id') ?? (await ensureDefaultScenario(user.id, profile.id)).id;
    const assumptions = await getResolvedAssumptions(user.id, profile.id, scenarioId);
    return ok({ profile, scenarioId, assumptions });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load assumptions');
  }
}

export async function PUT(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = forecastAssumptionUpsertSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);
  try {
    const profile = await getOrCreateForecastProfile(user.id);
    const updated = await upsertUserAssumption(user.id, profile.id, parsed.data);
    return ok(updated);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not save assumption');
  }
}
