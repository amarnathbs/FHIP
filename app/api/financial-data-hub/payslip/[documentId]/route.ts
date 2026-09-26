import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import {
  findRevisionPredecessor,
  getPayrollEventForReview,
  getPayrollEventIdForDocument,
} from '@/lib/financial-data-hub/services/payslipProcessingService';

// GET /api/financial-data-hub/payslip/{documentId} — the review read-model
// (spec section 32). Read-only: never mutates the payroll event, and never
// touches Income. WP-09: also says which earlier payslip this one would
// revise (same employer and period, different content), so the review step
// can ask "does this replace your earlier payslip?" (GAP-15).
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const payrollEventId = await getPayrollEventIdForDocument(user.id, documentId);
  if (!payrollEventId) return bad('No payroll evidence has been extracted from this document yet.', 404);

  const review = await getPayrollEventForReview(user.id, payrollEventId);
  if (!review) return bad('Payroll event not found.', 404);

  const revisionOf = await findRevisionPredecessor(user.id, payrollEventId).catch(() => null);
  return ok({ payroll_event: review.event, components: review.components, revision_of: revisionOf });
}
