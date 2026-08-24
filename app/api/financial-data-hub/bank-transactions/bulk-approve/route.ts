import { requireUser, bad, ok } from '@/lib/api';
import { bulkApproveTransactions } from '@/lib/financial-data-hub/services/approvalService';
import { fdhBulkTransactionApprovalSchema } from '@/lib/financial-data-hub/validation/transactions';

// POST /api/financial-data-hub/bank-transactions/bulk-approve — FDH-7 spec
// sections 49-51, 96. PER_ITEM_EXPLICIT_PARTIAL_SUCCESS contract (see
// lib/financial-data-hub/domain/approvalPolicy.ts): every id is validated
// independently; one blocked item never silently vetoes, or silently rides
// along with, the rest of the batch.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = fdhBulkTransactionApprovalSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  const result = await bulkApproveTransactions(user.id, parsed.data.transaction_ids);
  return ok(result);
}
