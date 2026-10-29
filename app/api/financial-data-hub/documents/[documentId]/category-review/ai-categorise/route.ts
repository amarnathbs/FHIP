import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { aiCategoriseStatement } from '@/lib/financial-data-hub/services/bankAiCategoriseService';
import { categoryReviewErrorResponse } from '@/lib/financial-data-hub/services/categoryReviewHttp';

// POST /api/financial-data-hub/documents/{documentId}/category-review/ai-categorise
// The OPTIONAL, Premium-only, last-resort AI step (AIE_BANK_CATEGORISE_AI_ENABLED, default OFF). Sends only masked, digit-free payee strings of
// lines the rules could not classify (never person-to-person lines), ONE call per up to 40 distinct payees, and records the answers as PROPOSALS
// (method 'ai'). It approves nothing. With the feature off it does nothing and says so: { status: 'disabled' }.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    return ok(await aiCategoriseStatement(user.id, documentId));
  } catch (e) {
    return categoryReviewErrorResponse(e, 'We could not suggest categories right now.');
  }
}
