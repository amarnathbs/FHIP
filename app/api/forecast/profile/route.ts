import { requireUser, ok, bad } from '@/lib/api';
import { getOrCreateForecastProfile, ensureDefaultScenario } from '@/lib/services/forecastData';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const profile = await getOrCreateForecastProfile(user.id);
    const scenario = await ensureDefaultScenario(user.id, profile.id);
    return ok({ profile, defaultScenario: scenario });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load forecast profile');
  }
}
