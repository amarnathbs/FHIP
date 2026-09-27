import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getLiabilityStatementIdForDocument } from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';
import { approveLiabilityStatementAtomic } from '@/lib/import-bridge/applyLiabilityProposalAtomic';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';
import { runLiabilityStatementForwardMatch } from '@/lib/import-bridge/liabilityBankBackMatch';

// POST /api/financial-data-hub/liability-statement/{documentId}/approve —
// spec sections 4, 22, 41. Approving statement EVIDENCE. Canonical Liability
// is UNCHANGED by this call (spec section 21) — it only moves
// `fdh_liability_statements.approval_status` to 'approved', and does so
// through `fdh10_approve_liability_statement()` (migration 0096 Part F.5),
// the one legitimate path for that column (never a direct PATCH).
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getLiabilityStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const result = await approveLiabilityStatementAtomic(statementId);
  if (!result.ok) return bad(result.error, 400);

  await recordDocumentAuditEvent({
    userId: user.id,
    documentId,
    eventType: 'liability_statement_approved',
    actorType: 'user',
    actorId: user.id,
    metadata: { statement_id: statementId },
  });

  // GP-D2: the bank statement may have been approved BEFORE this one; link any repayment it paid now
  // (the post-bank-approval back-match only sees card/loan statements that were already approved).
  // Best effort: a failure never undoes the approval; it is audited and the review still offers the
  // manual picker.
  let bankPaymentsLinked = 0;
  try {
    bankPaymentsLinked = (await runLiabilityStatementForwardMatch(user.id, statementId)).linked ?? 0;
  } catch (e) {
    await recordDocumentAuditEvent({
      userId: user.id,
      documentId,
      eventType: 'post_approval_matcher_failed',
      actorType: 'system',
      metadata: { matcher_id: 'gp_d2_liability_forward_match', trigger: 'liability_statement_approve', error_name: e instanceof Error ? e.name : 'Error' },
    });
  }

  return ok({ statement_id: statementId, approved: true, bank_payments_linked: bankPaymentsLinked });
}
