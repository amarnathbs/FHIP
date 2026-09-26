import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { setTransactionCategory } from '@/lib/financial-data-hub/services/categoryReviewService';
import { categoryReviewErrorResponse } from '@/lib/financial-data-hub/services/categoryReviewHttp';
import { fdhSetTransactionCategorySchema } from '@/lib/financial-data-hub/validation/transactions';

// POST /api/financial-data-hub/bank-transactions/{transactionId}/set-category
// The user's category choice for one of their own transactions. The
// economic type is derived on the server from the category; the method is
// recorded as the user's own ('user_manual'); `remember_payee: true` also
// saves a personal rule for this payee.
export async function POST(req: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const { transactionId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = fdhSetTransactionCategorySchema.safeParse(body);
  if (!parsed.success) return bad('Choose a category from the list.', 422);

  try {
    return ok(await setTransactionCategory(user.id, transactionId, parsed.data));
  } catch (e) {
    return categoryReviewErrorResponse(e, 'We could not save this category.');
  }
}
