import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { correctTransaction, BankTransactionActionError } from '@/lib/financial-data-hub/services/bankTransactionActionsService';
import { setTransactionCategory } from '@/lib/financial-data-hub/services/categoryReviewService';
import { categoryReviewErrorResponse } from '@/lib/financial-data-hub/services/categoryReviewHttp';
import { recordUserClassificationDecision } from '@/lib/financial-data-hub/services/transactionClassificationService';
import { transactionsRepository } from '@/lib/financial-data-hub/repositories';
import { bankTransactionCorrectionSchema } from '@/lib/financial-data-hub/validation/bankCsv';
import { fdhUuid } from '@/lib/financial-data-hub/validation/primitives';

// POST /api/financial-data-hub/bank-transactions/{transactionId}/correction — spec 47, 54.
//
// 2026-09-26 (production bug 1): a CATEGORY correction now goes through the
// same `setTransactionCategory` the category-totals review uses, so it also
// sets the economic type that category implies and records the method as the
// user's own. Before, only `category_id` changed: the row kept
// `economic_transaction_type = 'unknown'` (so FDH-7 could never approve it
// and the "uncategorised" tile kept counting it) and
// `classification_method = 'unclassified'`. A TYPE correction likewise now
// records the user's method. Every other field is unchanged.
export async function POST(req: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const { transactionId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = bankTransactionCorrectionSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  if (parsed.data.field_name === 'category_id') {
    const categoryId = fdhUuid.safeParse(parsed.data.corrected_value);
    if (!categoryId.success) return bad('Choose a category from the list.', 422);
    try {
      const result = await setTransactionCategory(user.id, transactionId, { category_id: categoryId.data, remember_payee: false });
      return ok({ transaction_id: result.transaction_id, field_name: 'category_id', user_override: true, economic_transaction_type: result.economic_transaction_type, classification_method: result.classification_method });
    } catch (e) {
      return categoryReviewErrorResponse(e, 'We could not save this correction.');
    }
  }

  try {
    const before = parsed.data.field_name === 'economic_transaction_type'
      ? (await transactionsRepository.getForUser(user.id, transactionId)).data
      : null;
    const transaction = await correctTransaction(user.id, transactionId, parsed.data);
    if (before && parsed.data.field_name === 'economic_transaction_type') {
      await recordUserClassificationDecision(user.id, {
        transactionId,
        previousEconomicType: before.economic_transaction_type,
        newEconomicType: transaction.economic_transaction_type,
        previousCategoryId: before.category_id,
        newCategoryId: transaction.category_id,
        previousSubcategoryId: before.subcategory_id,
        clearSubcategory: false,
      });
    }
    return ok({ transaction_id: transaction.id, field_name: parsed.data.field_name, user_override: transaction.user_override });
  } catch (e) {
    if (e instanceof BankTransactionActionError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 409;
      return bad(e.message, status);
    }
    return bad('We could not save this correction.', 500);
  }
}
