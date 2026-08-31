import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getRetirementStatementIdForDocument } from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import { applyRetirementProposalAtomic } from '@/lib/import-bridge/applyRetirementProposalAtomic';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

// POST /api/financial-data-hub/retirement-statement/{documentId}/apply
//
// ============================================================================
// THE ONLY ROUTE IN FDH-12 THAT CAN CHANGE CANONICAL RETIREMENT
// ============================================================================
//
// Everything before it — upload, parse, account match, payslip reconciliation,
// bank matching, balance reconciliation, review, approve evidence, compare —
// leaves `retirement_accounts` byte-for-byte unchanged (spec sections 56,
// 129). This route delegates to `fdh12_apply_retirement_proposal()`, the single
// atomic SECURITY DEFINER RPC (migration 0112 PART I) that:
//
//   * refuses an SMSF target                       (spec sections 10, 72)
//   * refuses unapproved evidence                  (spec section 56)
//   * cannot write target_retirement_age           (spec sections 61, 113)
//   * cannot write any column outside its v_allowed (spec section 104)
//   * refuses a stale proposal                     (spec section 108)
//   * is idempotent: second call -> ALREADY_APPLIED (spec section 106)
//   * is race-safe: compare-and-swap claim          (spec section 107)
//
// UI CONFIRMATION IS NOT AUTHORISATION. This route passes the user's decision
// through; the RPC re-derives every check itself against the live database.

const bodySchema = z.object({
  proposal_id: z.string().uuid(),
  decision: z.enum(['add_new', 'update_existing', 'apply_selected_fields', 'keep_existing']),
  // SELECTED APPLY (spec section 109): only the ticked fields may mutate
  // canonical data. Unselected fields remain unchanged, which the RPC enforces
  // by only ever building its SET clause from this list.
  selected_fields: z.array(z.string().max(64)).max(32).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getRetirementStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return bad('Unrecognised request.', 400);
  const body = parsed.data;

  const result = await applyRetirementProposalAtomic({
    proposalId: body.proposal_id,
    decision: body.decision,
    selectedFields: body.selected_fields,
  });

  if (!result.ok) {
    await recordDocumentAuditEvent({
      userId: user.id,
      documentId,
      eventType: 'retirement_proposal_applied',
      actorType: 'user',
      actorId: user.id,
      metadata: { statementId, proposalId: body.proposal_id, outcome: 'refused', code: result.code, refusalCode: result.refusalCode ?? null },
    });
    // 409 for the states that are a legitimate conflict rather than a bad
    // request: the user is not at fault and the UI should re-read and re-offer.
    const conflict = result.code === 'STALE_PROPOSAL'
      || result.code === 'ALREADY_APPLIED'
      || result.refusalCode !== undefined;
    return bad(result.error, conflict ? 409 : 400);
  }

  // KEEP EXISTING (spec section 110): the proposal is dismissed, canonical
  // retirement data is unchanged, and the statement evidence remains available
  // under the ordinary FDH-3 lifecycle.
  if (result.outcome === 'kept_existing') {
    await recordDocumentAuditEvent({
      userId: user.id,
      documentId,
      eventType: 'retirement_proposal_dismissed',
      actorType: 'user',
      actorId: user.id,
      metadata: { statementId, proposalId: body.proposal_id },
    });
    return ok({ outcome: 'kept_existing', applied_fields: [], target_entity_id: null, application_id: null });
  }

  await recordDocumentAuditEvent({
    userId: user.id,
    documentId,
    eventType: 'retirement_proposal_applied',
    actorType: 'user',
    actorId: user.id,
    metadata: {
      statementId,
      proposalId: body.proposal_id,
      applyMode: result.applyMode,
      targetEntityId: result.targetEntityId,
      appliedFields: result.appliedFields,
    },
  });

  return ok({
    outcome: 'applied',
    apply_mode: result.applyMode,
    target_entity_id: result.targetEntityId,
    application_id: result.applicationId,
    applied_fields: result.appliedFields,
  });
}
