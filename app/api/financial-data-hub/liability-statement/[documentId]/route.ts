import { requireUser, bad, ok } from '@/lib/api';
import { getLiabilityStatementIdForDocument, getLiabilityStatementForReview } from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';

// GET /api/financial-data-hub/liability-statement/{documentId} — the review
// read-model (spec sections 19, 22-23). Read-only: never mutates the
// statement evidence, and never touches Liabilities.
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getLiabilityStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const review = await getLiabilityStatementForReview(user.id, statementId);
  if (!review) return bad('Statement not found.', 404);

  return ok({ statement: review.statement, activities: review.activities });
}
