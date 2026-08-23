import { requireUser, bad, ok } from '@/lib/api';
import { resolveDuplicateCandidate, BankTransactionActionError } from '@/lib/financial-data-hub/services/bankTransactionActionsService';
import { bankTransactionDuplicateResolutionSchema } from '@/lib/financial-data-hub/validation/bankCsv';

// POST /api/financial-data-hub/bank-transactions/{transactionId}/duplicate-resolution
// spec section 36, 54, 82.
export async function POST(req: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const { transactionId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = bankTransactionDuplicateResolutionSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  try {
    await resolveDuplicateCandidate(user.id, transactionId, parsed.data);
    return ok({ resolved: true });
  } catch (e) {
    if (e instanceof BankTransactionActionError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 409;
      return bad(e.message, status);
    }
    return bad('We could not resolve this duplicate.', 500);
  }
}
