import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import {
  findRevisionPredecessor,
  getPayrollEventForReview,
  getPayrollEventIdForDocument,
  supersedePayrollEvent,
} from '@/lib/financial-data-hub/services/payslipProcessingService';
import { approvePayrollEventAtomic } from '@/lib/import-bridge/applyIncomeProposalAtomic';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

// WP-09. Every field is optional so an older client (an empty POST) keeps
// working: owner defaults to 'self' inside the RPC, and a payslip that needs
// review is refused (REVIEW_REQUIRED) until the user acknowledges it.
const bodySchema = z
  .object({
    /** Whose payslip this is (GAP-05). */
    income_owner: z.enum(['self', 'spouse']).optional(),
    /** The user has checked the figures this payslip flagged for review. */
    acknowledge_review: z.boolean().optional(),
    /** The user confirmed this payslip replaces an earlier one for the same
     * employer and pay period (GAP-15). The earlier payslip is re-derived on
     * the server -- the client never names it. */
    replaces_earlier: z.boolean().optional(),
  })
  .strict();

// POST /api/financial-data-hub/payslip/{documentId}/approve — spec sections
// 4, 10, 32, 36, 42. Approving payroll EVIDENCE. Canonical Income is
// UNCHANGED by this call (spec section 36) — it only moves
// `fdh_payroll_events.approval_status` to 'approved' (and, since 0210, records
// the owner and the review acknowledgement), and does so through
// `fdh9_approve_payroll_event()`, the one legitimate path for those columns
// (spec section 31: apply/approve must go through the atomic RPC, never a
// direct PATCH).
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  let body: z.infer<typeof bodySchema> = {};
  const raw = await req.text().catch(() => '');
  if (raw.trim() !== '') {
    let json: unknown = null;
    try { json = JSON.parse(raw); } catch { json = null; }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return bad('Invalid request body.', 422);
    body = parsed.data;
  }

  const payrollEventId = await getPayrollEventIdForDocument(user.id, documentId);
  if (!payrollEventId) return bad('No payroll evidence has been extracted from this document yet.', 404);

  // Review gate, checked here as well as in the RPC so the pre-0210 fallback
  // (one-argument RPC) is gated too.
  const review = await getPayrollEventForReview(user.id, payrollEventId);
  const reviewStatus = (review?.event as { review_status?: string; approval_status?: string } | undefined)?.review_status;
  const alreadyApproved = (review?.event as { approval_status?: string } | undefined)?.approval_status === 'approved';
  if (!alreadyApproved && (reviewStatus === 'pending' || reviewStatus === 'in_review') && !body.acknowledge_review) {
    return Response.json(
      { error: 'Some figures on this payslip need your check. Confirm you have reviewed them before approving.', code: 'REVIEW_REQUIRED' },
      { status: 409 },
    );
  }

  const result = await approvePayrollEventAtomic(payrollEventId, {
    incomeOwner: body.income_owner,
    acknowledgeReview: body.acknowledge_review,
  });
  if (!result.ok) {
    const status = result.code === 'REVIEW_REQUIRED' || result.code === 'OWNER_LOCKED' || result.code === 'EVENT_SUPERSEDED' ? 409 : result.code === 'MIGRATION_PENDING' ? 503 : 400;
    return Response.json({ error: result.error, code: result.code }, { status });
  }

  await recordDocumentAuditEvent({
    userId: user.id,
    documentId,
    eventType: 'payroll_event_approved',
    actorType: 'user',
    actorId: user.id,
    metadata: {
      payroll_event_id: payrollEventId,
      income_owner: result.incomeOwner,
      review_acknowledged: Boolean(body.acknowledge_review) && (reviewStatus === 'pending' || reviewStatus === 'in_review'),
    },
  });

  // A revised payslip replaces the earlier one only when the user said so.
  let superseded: { payroll_event_id: string; bank_match_moved: boolean } | null = null;
  let supersedeError: string | null = null;
  if (body.replaces_earlier) {
    const predecessor = await findRevisionPredecessor(user.id, payrollEventId);
    if (predecessor) {
      const s = await supersedePayrollEvent(predecessor.payroll_event_id, payrollEventId);
      if (s.ok) superseded = { payroll_event_id: predecessor.payroll_event_id, bank_match_moved: s.bankMatchMoved };
      else supersedeError = s.code;
    }
  }

  return ok({
    payroll_event_id: payrollEventId,
    approved: true,
    already_approved: result.alreadyApproved,
    income_owner: result.incomeOwner,
    superseded,
    supersede_error: supersedeError,
  });
}
