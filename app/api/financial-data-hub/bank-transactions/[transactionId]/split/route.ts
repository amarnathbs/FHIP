import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { splitTransaction, TransactionSplitError } from '@/lib/financial-data-hub/services/transactionSplitService';
import { fdhTransactionSplitRequestSchema } from '@/lib/financial-data-hub/validation/transactions';

// POST /api/financial-data-hub/bank-transactions/{transactionId}/split — FDH-7
// spec sections 44-48: create or replace the split allocations for one owned
// transaction. `finalize: true` requires an exact reconciliation (spec 45-46).
export async function POST(req: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const { transactionId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = fdhTransactionSplitRequestSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  try {
    const { allocations } = await splitTransaction(user.id, transactionId, parsed.data);
    return ok({
      transaction_id: transactionId,
      finalized: parsed.data.finalize,
      allocations: allocations.map((a) => ({
        allocation_sequence: a.allocation_sequence,
        economic_transaction_type: a.economic_transaction_type,
        category_id: a.category_id,
        subcategory_id: a.subcategory_id,
        amount: a.amount,
        note: a.note,
      })),
    });
  } catch (e) {
    if (e instanceof TransactionSplitError) {
      return bad(e.message, e.code === 'not_found' ? 404 : 422);
    }
    return bad('We could not save this split.', 500);
  }
}
