import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { classifyUserTransactions } from '@/lib/financial-data-hub/services/transactionClassificationService';

// POST /api/financial-data-hub/bank-transactions/classify — R8 spec section
// 91 governing principle: proves the correct economic interpretation, or
// explicitly admits it cannot determine one, for every one of the calling
// user's own canonical bank transactions. Idempotent — safe to call again
// after a new statement import or after correcting a transaction.
export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const summary = await classifyUserTransactions(user.id);
    return ok(summary);
  } catch {
    return bad('We could not run classification for your transactions.', 500);
  }
}
