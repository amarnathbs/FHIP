import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { transitionPromptStatus, type PromptStatus } from '@/lib/ai/promptRegistry';

const VALID_STATUSES: PromptStatus[] = ['DRAFT', 'TESTING', 'APPROVED', 'ACTIVE', 'RETIRED'];

export const PUT = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (!VALID_STATUSES.includes(body.status)) return bad(`status must be one of ${VALID_STATUSES.join(', ')}`, 422);
  try {
    const updated = await transitionPromptStatus(id, body.status, user!.id);
    return ok(updated);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to update prompt template.', 500);
  }
});
