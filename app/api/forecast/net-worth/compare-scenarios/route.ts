import { requireUser, ok, bad } from '@/lib/api';
import { getOrCreateForecastProfile, compareNetWorthAcrossScenarios } from '@/lib/services/forecastData';

export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const profile = await getOrCreateForecastProfile(user.id);
    const comparisons = await compareNetWorthAcrossScenarios(user.id, profile.id);
    return ok({ comparisons });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not compare scenarios');
  }
}
