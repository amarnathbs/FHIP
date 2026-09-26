import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import {
  chooseLiabilityPaymentMatch,
  LiabilityStatementProcessingError,
} from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';

const bodySchema = z.object({
  activity_id: z.string().uuid(),
  // null = "none of these is the repayment".
  bank_transaction_id: z.string().uuid().nullable(),
});

// POST /api/financial-data-hub/liability-statement/{documentId}/match-payment
// — WP-11 (G4). The user chooses which of the several possible bank debits
// paid a statement repayment (or none of them). Only a debit the extraction
// persisted as a candidate is accepted, and the database re-verifies it
// (fdh10_match_liability_payment, migration 0209). User identity comes only
// from the session; the body names the line and the choice, nothing else.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad('Invalid request body.', 422);

  try {
    const result = await chooseLiabilityPaymentMatch(user.id, documentId, parsed.data.activity_id, parsed.data.bank_transaction_id);
    return ok({ outcome: result.outcome });
  } catch (e) {
    if (e instanceof LiabilityStatementProcessingError) {
      return bad(e.message, e.code === 'not_found' ? 404 : 409);
    }
    console.error(`liability match-payment failed for ${documentId}: ${e instanceof Error ? e.message : 'unknown'}`);
    return bad('That choice could not be saved.', 500);
  }
}
