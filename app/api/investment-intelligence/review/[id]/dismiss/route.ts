import { requireUser, ok, bad } from '@/lib/api';
import { iiReviewActionSchema } from '@/lib/validation/investment-intelligence';
import { dismissReviewItem } from '@/lib/services/investment-intelligence/reviewCentreData';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = iiReviewActionSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return bad(parsed.error.message, 422);
  const result = await dismissReviewItem(user.id, id, parsed.data.note ?? null);
  if (result.error) return bad(result.error, 400);
  return ok({ dismissed: true });
}
