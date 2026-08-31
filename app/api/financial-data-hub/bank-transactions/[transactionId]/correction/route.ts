import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { correctTransaction, BankTransactionActionError } from '@/lib/financial-data-hub/services/bankTransactionActionsService';
import { bankTransactionCorrectionSchema } from '@/lib/financial-data-hub/validation/bankCsv';

// POST /api/financial-data-hub/bank-transactions/{transactionId}/correction — spec 47, 54.
export async function POST(req: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const { transactionId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = bankTransactionCorrectionSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  try {
    const transaction = await correctTransaction(user.id, transactionId, parsed.data);
    return ok({ transaction_id: transaction.id, field_name: parsed.data.field_name, user_override: transaction.user_override });
  } catch (e) {
    if (e instanceof BankTransactionActionError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 409;
      return bad(e.message, status);
    }
    return bad('We could not save this correction.', 500);
  }
}
