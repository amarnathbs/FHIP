import { requireUser, bad, ok } from '@/lib/api';
import { getPayrollEventIdForDocument } from '@/lib/financial-data-hub/services/payslipProcessingService';
import { approvePayrollEventAtomic } from '@/lib/import-bridge/applyIncomeProposalAtomic';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

// POST /api/financial-data-hub/payslip/{documentId}/approve — spec sections
// 4, 10, 32, 36, 42. Approving payroll EVIDENCE. Canonical Income is
// UNCHANGED by this call (spec section 36) — it only moves
// `fdh_payroll_events.approval_status` to 'approved', and does so through
// `fdh9_approve_payroll_event()`, the one legitimate path for that column
// (spec section 31: apply/approve must go through the atomic RPC, never a
// direct PATCH).
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const payrollEventId = await getPayrollEventIdForDocument(user.id, documentId);
  if (!payrollEventId) return bad('No payroll evidence has been extracted from this document yet.', 404);

  const result = await approvePayrollEventAtomic(payrollEventId);
  if (!result.ok) return bad(result.error, 400);

  await recordDocumentAuditEvent({
    userId: user.id,
    documentId,
    eventType: 'payroll_event_approved',
    actorType: 'user',
    actorId: user.id,
    metadata: { payroll_event_id: payrollEventId },
  });

  return ok({ payroll_event_id: payrollEventId, approved: true });
}
