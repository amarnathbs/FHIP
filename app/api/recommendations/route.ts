import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { runRecommendationEvaluation, getLatestRecommendations } from '@/lib/services/recommendationsData';

export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (unauthenticated) return unauthenticated;
  const supabase = await createClient();
  try {
    const existing = await getLatestRecommendations(user!.id, supabase);
    if (existing.length > 0) return ok(existing);

    const { searchParams } = new URL(req.url);
    const scenarioId = searchParams.get('scenario') ?? undefined;
    await runRecommendationEvaluation(user!.id, scenarioId, supabase);
    return ok(await getLatestRecommendations(user!.id, supabase));
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load recommendations');
  }
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (unauthenticated) return unauthenticated;
  const supabase = await createClient();
  const body = await req.json().catch(() => ({}));
  try {
    await runRecommendationEvaluation(user!.id, body.scenario_id, supabase);
    return ok(await getLatestRecommendations(user!.id, supabase));
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not evaluate recommendations');
  }
}
