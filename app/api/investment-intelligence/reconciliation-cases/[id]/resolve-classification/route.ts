import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { recertifyPosition } from '@/lib/services/investment-intelligence/documentProcessing';
import { z } from 'zod';

// Document2 final non-benchmark closure #10 (2026-09-30) — a genuine
// resolution path for `transaction_unclassified`. Discovery found the prior
// mission's own matrix claim ("transaction_unclassified has a classification
// path per documentProcessing.ts's wiring") was INACCURATE: that wiring is
// the SYSTEM's own initial classification during parsing
// (transactionTypeMapping.ts), not a user-facing re-classification action —
// no such route or UI existed before this one. This matters more than most
// of the other disclosed gaps: a MATERIAL ('high' severity) unclassified
// transaction is a genuine certification BLOCKER
// (certification.ts's `hasMaterialUnclassifiedTransaction`), so without a
// real fix a position could be stuck "needs review" forever with no way out
// other than re-uploading a corrected statement (which does not exist for a
// line the source document genuinely printed this way).
//
// The user chooses the correct canonical transaction type from the SAME
// closed vocabulary the DB's own `ii_transactions_transaction_type_check`
// constraint enforces (never a free-form string) — 'unclassified' itself is
// refused as a "correction" (that would be a no-op). The correction IS the
// resolution: `ii_transactions.transaction_type` is updated for real, then
// the affected position is immediately recertified
// (`recertifyPosition`) so a cleared blocker takes effect without a second,
// separate action.
const VALID_RECLASSIFICATION_TYPES = [
  'purchase', 'sip', 'redemption', 'switch_in', 'switch_out', 'dividend', 'reinvestment',
  'transfer', 'merger', 'fee', 'tax', 'adjustment', 'stp_in', 'stp_out', 'swp',
  'transfer_in', 'transfer_out', 'reversal', 'segregation', 'bonus', 'split', 'sale',
] as const;
const resolveSchema = z.object({ transactionType: z.enum(VALID_RECLASSIFICATION_TYPES) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: caseId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = resolveSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from('ii_reconciliation_cases')
    .select('id, status, discrepancy_type, discrepancy_details')
    .eq('id', caseId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!existing) return bad('Reconciliation case not found.', 404);
  if (existing.discrepancy_type !== 'transaction_unclassified') return bad('This case cannot be resolved this way.', 422);

  const details = (existing.discrepancy_details as Record<string, unknown> | null) ?? {};
  const transactionId = typeof details.newTransactionId === 'string' ? details.newTransactionId : null;
  if (!transactionId) return bad('This case has no resolvable transaction on record.', 422);

  if (existing.status === 'resolved') {
    if (details.reclassifiedAs === parsed.data.transactionType) return ok({ caseId, transactionType: parsed.data.transactionType, alreadyResolved: true });
    return bad('This issue has already been resolved with a different classification.', 409, 'already_resolved');
  }
  if (existing.status !== 'open') return bad(`Cannot resolve a case with status '${existing.status}'.`, 422);

  const { data: txn } = await admin.from('ii_transactions').select('id, account_id, instrument_id, transaction_type').eq('id', transactionId).eq('user_id', user.id).maybeSingle();
  if (!txn) return bad('The transaction this issue refers to could not be found.', 404);

  const { error: updateErr } = await admin.from('ii_transactions').update({ transaction_type: parsed.data.transactionType }).eq('id', transactionId).eq('user_id', user.id);
  if (updateErr) return bad(updateErr.message);

  const nowIso = new Date().toISOString();
  const { error: resolveErr } = await admin
    .from('ii_reconciliation_cases')
    .update({
      status: 'resolved',
      resolved_at: nowIso,
      resolution_method: 'user_classified_transaction',
      resolved_by: user.id,
      resolved_by_actor_type: 'user',
      discrepancy_details: { ...details, reclassifiedAs: parsed.data.transactionType },
    })
    .eq('id', caseId)
    .eq('user_id', user.id)
    .eq('status', 'open');
  if (resolveErr) return bad(resolveErr.message);

  await emitAuditEvent({
    userId: user.id,
    eventType: 'user_correction',
    subjectType: 'ii_transactions',
    subjectId: transactionId,
    actorType: 'user',
    actorId: user.id,
    metadata: { reconciliationCaseId: caseId, field: 'transaction_type', previousValue: txn.transaction_type, newValue: parsed.data.transactionType },
  });

  // The correction IS the resolution: recertify the affected position now,
  // same pattern as every other real fix action in this module (owner
  // assignment, ambiguous-instrument resolution) — a cleared blocker takes
  // effect immediately rather than requiring a separate discovery step.
  let recertified = false;
  let recertifyError: string | null = null;
  try {
    const result = await recertifyPosition(user.id, txn.account_id as string, txn.instrument_id as string);
    recertified = result.ok;
    if (!result.ok) recertifyError = result.error;
  } catch (e) {
    recertifyError = e instanceof Error ? e.message : 'Recertification failed unexpectedly.';
  }

  return ok({ caseId, transactionType: parsed.data.transactionType, recertified, recertifyError });
}
