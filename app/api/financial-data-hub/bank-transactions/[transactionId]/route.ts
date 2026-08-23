import { requireUser, bad, ok } from '@/lib/api';
import { transactionsRepository } from '@/lib/financial-data-hub/repositories';

// GET /api/financial-data-hub/bank-transactions/{transactionId} — spec 54.
export async function GET(_req: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const { transactionId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const { data } = await transactionsRepository.getForUser(user.id, transactionId);
  if (!data) return bad('transaction not found', 404);
  return ok(data);
}
