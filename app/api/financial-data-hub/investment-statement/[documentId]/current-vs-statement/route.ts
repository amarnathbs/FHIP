import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getAuInvestmentStatementIdForDocument } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { computeCurrentVsStatement } from '@/lib/investment-import-bridge/currentVsStatement';

// GET /api/financial-data-hub/investment-statement/{documentId}/current-vs-statement
// spec section 61 — read-only comparison, never a write.
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getAuInvestmentStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const result = await computeCurrentVsStatement(user.id, statementId);
  if (result.error) return bad(result.error, 500);

  return ok(result);
}
