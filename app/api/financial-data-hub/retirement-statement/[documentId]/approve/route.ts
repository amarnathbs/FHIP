import { requireUser, bad, ok } from '@/lib/api';
import { getRetirementStatementIdForDocument } from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import { approveRetirementStatementAtomic } from '@/lib/import-bridge/applyRetirementProposalAtomic';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

// POST /api/financial-data-hub/retirement-statement/{documentId}/approve
//
// Approving statement EVIDENCE (spec section 56). CANONICAL RETIREMENT IS
// UNCHANGED BY THIS CALL — it only unlocks Apply. The whole of spec section 56
// is this distinction, and `fdh12_approve_retirement_statement()` (migration
// 0111 PART H) is where it is enforced: that function writes to
// `fdh_retirement_statements` and to nothing else.

/** Refusals that are a legitimate state rather than an error, mapped to the
 * HTTP status that says so. */
const CONFLICT_CODES = new Set([
  'ROUTED_TO_SMSF',        // spec section 11 — terminal for FDH-12
  'SMSF_REVIEW_REQUIRED',  // ambiguous SMSF; the user must confirm first
  'REVIEW_REQUIRED',       // spec sections 27, 66, 80 — unresolved matches
  'NOT_EXTRACTED',
]);

export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getRetirementStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const result = await approveRetirementStatementAtomic(statementId);
  if (!result.ok) {
    return bad(result.error, CONFLICT_CODES.has(result.code) ? 409 : 400);
  }

  await recordDocumentAuditEvent({
    userId: user.id,
    documentId,
    eventType: 'retirement_statement_approved',
    actorType: 'user',
    actorId: user.id,
    metadata: { statementId, code: result.code },
  });

  return ok({ statement_id: statementId, approved: true, code: result.code });
}
