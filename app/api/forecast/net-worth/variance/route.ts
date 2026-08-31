import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { getOrCreateForecastProfile, ensureDefaultScenario, getNetWorthVariance } from '@/lib/services/forecastData';

export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const profile = await getOrCreateForecastProfile(user.id);
    const url = new URL(req.url);
    const scenarioId = url.searchParams.get('scenario_id') ?? (await ensureDefaultScenario(user.id, profile.id)).id;
    const variance = await getNetWorthVariance(user.id, profile.id, scenarioId);
    return ok(variance);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load net worth variance');
  }
}
