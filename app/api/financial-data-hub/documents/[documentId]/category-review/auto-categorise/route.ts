import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { getAutoCategoriseState, runAutoCategorise } from '@/lib/financial-data-hub/services/premiumAutoCategoriseService';
import { categoryReviewErrorResponse } from '@/lib/financial-data-hub/services/categoryReviewHttp';
import { runPostBankApprovalHook } from '../../../postBankApprovalHook';

// GET  /api/financial-data-hub/documents/{documentId}/category-review/auto-categorise
//   What the review screen needs: is the Premium automatic categorisation on, may it start for this statement, and the latest run's counts for the banner.
// POST /api/financial-data-hub/documents/{documentId}/category-review/auto-categorise
//   Runs it once for this statement (Premium + AIE_BANK_AUTO_CATEGORISE_ENABLED, both re-checked here). A second call does nothing ('already_ran').
// Both are scoped to the signed-in user: another user's statement id is a 404.
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    return ok(await getAutoCategoriseState(user.id, documentId));
  } catch (e) {
    return categoryReviewErrorResponse(e, 'We could not check the automatic categorisation.');
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const result = await runAutoCategorise(user.id, documentId);
    // WP-01 seam (see approve-group/route.ts): lines were newly approved.
    if ((result.summary?.approved_lines ?? 0) > 0) await runPostBankApprovalHook(user.id, documentId, 'category_approve_group');
    return ok(result);
  } catch (e) {
    return categoryReviewErrorResponse(e, 'We could not categorise this statement automatically.');
  }
}
