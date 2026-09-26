import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getRetirementStatementIdForDocument } from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import { confirmRetirementBankLeg } from '@/lib/import-bridge/retirementBankLegLink';

// POST /api/financial-data-hub/retirement-statement/{documentId}/bank-leg
//   body: { activity_id }
//
// WP-13 (GAP-RET-07): the user confirms that the bank payment matched to one
// statement line (a personal contribution, withdrawal or pension payment) IS
// that retirement movement. fdh12_confirm_retirement_bank_leg (migration 0211)
// re-verifies the match against live rows and counts the bank payment ONCE:
// a contribution or withdrawal becomes a transfer (not spending / not income),
// a pension payment becomes income. A payment the user categorised themselves
// is left exactly as they set it. Idempotent.
//
// This route changes no canonical Retirement row: the fund balance comes only
// from an applied statement's closing balance.

const bodySchema = z.object({ activity_id: z.string().uuid() });

export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return bad('Unrecognised request.', 400);

  const statementId = await getRetirementStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  // The line must belong to THIS document's statement (the RPC independently
  // proves it belongs to this user).
  const supabase = await createClient();
  const { data: line } = await supabase
    .from('fdh_retirement_statement_activities')
    .select('id, statement_id')
    .eq('id', parsed.data.activity_id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!line || line.statement_id !== statementId) return bad('That statement line could not be found.', 404);

  const result = await confirmRetirementBankLeg(parsed.data.activity_id);
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'WRITE_FAILED' ? 500 : 409;
    return bad(result.error, status);
  }
  return ok({
    code: result.code,
    outcome: result.outcome,
    counted_as: result.newType,
    transaction_id: result.transactionId,
  });
}
