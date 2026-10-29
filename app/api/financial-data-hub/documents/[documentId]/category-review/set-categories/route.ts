import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { setCategoriesBulk } from '@/lib/financial-data-hub/services/categoryBulkService';
import { categoryReviewErrorResponse } from '@/lib/financial-data-hub/services/categoryReviewHttp';
import { fdhBulkSetCategorySchema } from '@/lib/financial-data-hub/validation/transactions';

// Up to 500 lines are written in one request (batched writes, not one request per line).
export const maxDuration = 60;

// POST /api/financial-data-hub/documents/{documentId}/category-review/set-categories
// Assigns categories to many of one statement's own lines in ONE request: one
// category for all selected lines, or each line's own suggested category. The
// same rules and evidence as the single "set-category" route. It NEVER approves:
// approval stays the separate explicit step. Not all-or-nothing: the response
// lists every line as applied, unchanged or failed (with the reason), so nothing
// is skipped silently; repeating the same request is a no-op.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = fdhBulkSetCategorySchema.safeParse(body);
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some((i) => i.code === 'too_big');
    return bad(tooMany ? 'Choose up to 500 transactions at a time.' : parsed.error.issues[0]?.message ?? 'Choose the transactions and a category.', 422);
  }

  try {
    return ok(await setCategoriesBulk(user.id, documentId, parsed.data));
  } catch (e) {
    return categoryReviewErrorResponse(e, 'We could not save these categories.');
  }
}
