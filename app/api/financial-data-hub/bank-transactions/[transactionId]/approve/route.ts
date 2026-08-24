import { requireUser, bad, ok } from '@/lib/api';
import { approveTransaction, ApprovalError } from '@/lib/financial-data-hub/services/approvalService';

// POST /api/financial-data-hub/bank-transactions/{transactionId}/approve —
// FDH-7 spec sections 26, 52, 55, 108-110. A deliberate user action; blocking
// review issues are re-checked server-side regardless of UI state, and the
// DB trigger is the actual, un-bypassable enforcement (migration 0076).
export async function POST(_req: Request, { params }: { params: Promise<{ transactionId: string }> }) {
  const { transactionId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const transaction = await approveTransaction(user.id, transactionId);
    return ok({
      transaction_id: transaction.id,
      approval_status: transaction.approval_status,
      approved_at: transaction.approved_at,
    });
  } catch (e) {
    if (e instanceof ApprovalError) {
      return bad(e.message, e.code === 'not_found' ? 404 : e.code === 'blocked' ? 409 : 422);
    }
    return bad('We could not approve this transaction.', 500);
  }
}
