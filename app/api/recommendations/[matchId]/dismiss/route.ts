import { requireUser, ok, bad } from '@/lib/api';
import { dismissRecommendationMatch } from '@/lib/services/recommendationsData';

export async function POST(_req: Request, { params }: { params: Promise<{ matchId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (unauthenticated) return unauthenticated;
  const { matchId } = await params;
  try {
    await dismissRecommendationMatch(user!.id, matchId);
    return ok({ dismissed: true });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not dismiss recommendation');
  }
}
