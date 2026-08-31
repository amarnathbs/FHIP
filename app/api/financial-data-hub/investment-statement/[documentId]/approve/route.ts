import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getAuInvestmentStatementIdForDocument } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { approveAuStatement } from '@/lib/investment-import-bridge/approveAuStatement';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

// POST /api/financial-data-hub/investment-statement/{documentId}/approve
// spec sections 63, 76. Approving statement EVIDENCE. Canonical Investment
// Intelligence is UNCHANGED by this call — it only unlocks Apply.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getAuInvestmentStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const result = await approveAuStatement(user.id, statementId);
  if (!result.ok) return bad(result.error ?? 'Could not approve this statement.', 400);

  await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_approved', actorType: 'user', actorId: user.id, metadata: { statementId } });

  return ok({ statement_id: statementId, approved: true });
}
