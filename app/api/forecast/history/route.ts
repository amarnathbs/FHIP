import { requireUser, ok, bad } from '@/lib/api';
import { getOrCreateForecastProfile, listForecastRuns } from '@/lib/services/forecastData';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const profile = await getOrCreateForecastProfile(user.id);
    const runs = await listForecastRuns(user.id, profile.id);
    return ok({ profile, runs });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load forecast history');
  }
}
