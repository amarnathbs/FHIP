import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { z } from 'zod';

// Document2 final non-benchmark closure #4 (2026-09-30) — a genuine
// resolution path for the `cross_source_*` discrepancy family.
//
// DISCOVERY (per the mission's own instruction to classify each code as
// A. user / B. system / C. source-document correction / D. explicit
// conflict-choice / E. informational, rather than building a button for
// every code by default):
//
//  - `cross_source_exact_duplicate` / `cross_source_high_confidence_duplicate`
//    (severity 'info'): documentProcessing.ts/manualImporter.ts already
//    auto-resolve these THE MOMENT they are opened
//    (`resolved_by_actor_type: 'system'`, `resolution_method:
//    'auto_resolved_cross_source_precedence'`) — category B, system-handled,
//    already informational-only and already closed. No further action
//    needed; they were never stuck open.
//  - `cross_source_holding_conflict` is defined in the closed vocabulary but
//    has no emitter anywhere in the codebase (confirmed by a repository-wide
//    search) — unreachable today, carried for a future holding-level (not
//    transaction-level) cross-source check that does not yet exist.
//  - `cross_source_conflict` / `cross_source_review_required` (severity
//    'high', left OPEN): a second source disagrees with — or cannot be
//    confidently matched or ruled out against — an already-recorded
//    transaction for the same real-world event. This is category D, an
//    EXPLICIT CONFLICT-CHOICE the user is the only one who can make (only a
//    human knows whether two similar-looking transactions are the same
//    real-world event recorded twice, or two genuinely separate ones) — this
//    route is that choice.
//
// The new transaction this case is about is ALREADY written (with
// `status='review_required'`, which every R4/R5/R6 "usable" filter already
// excludes from analytical aggregation — see documentProcessing.ts's own
// comment at the insert site). Nothing is ever deleted (spec section 29,
// "never discard evidence"):
//   - 'confirmed_duplicate': the user confirms this IS the same real-world
//     event as the compared transaction(s). The row stays exactly as
//     written — already correctly excluded from aggregation — and the case
//     is resolved so it is no longer presented as an open, unresolved
//     conflict.
//   - 'confirmed_distinct': the user confirms this is a genuinely SEPARATE
//     real transaction, not a duplicate. The one canonical data change this
//     resolution makes: the transaction's own `status` moves from
//     'review_required' back to 'parsed' — the normal status any other new
//     transaction gets — so it re-enters R4/R5/R6 aggregation exactly like
//     any other transaction. This is a real, in-scope, per-row correction
//     (a status field is canonical, reconciliation-visible data), not a
//     display-only relabel.
const resolveSchema = z.object({ decision: z.enum(['confirmed_duplicate', 'confirmed_distinct']) });
const CROSS_SOURCE_CONFLICT_TYPES = ['cross_source_conflict', 'cross_source_review_required'] as const;

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
  if (!CROSS_SOURCE_CONFLICT_TYPES.includes(existing.discrepancy_type as (typeof CROSS_SOURCE_CONFLICT_TYPES)[number])) {
    return bad('This case cannot be resolved this way.', 422);
  }

  const details = (existing.discrepancy_details as Record<string, unknown> | null) ?? {};
  const newTransactionId = typeof details.newTransactionId === 'string' ? details.newTransactionId : null;
  if (!newTransactionId) return bad('This case has no resolvable transaction on record.', 422);

  if (existing.status === 'resolved') {
    const alreadyDecision = details.userDecision;
    if (alreadyDecision === parsed.data.decision) {
      return ok({ caseId, decision: parsed.data.decision, alreadyResolved: true });
    }
    return bad('This issue has already been resolved with a different decision.', 409, 'already_resolved');
  }
  if (existing.status !== 'open') return bad(`Cannot resolve a case with status '${existing.status}'.`, 422);

  // Never trust that the recorded transaction id still belongs to this user
  // and is still in the exact state this resolution expects.
  const { data: txn } = await admin.from('ii_transactions').select('id, status').eq('id', newTransactionId).eq('user_id', user.id).maybeSingle();
  if (!txn) return bad('The transaction this issue refers to could not be found.', 404);

  if (parsed.data.decision === 'confirmed_distinct') {
    if (txn.status === 'review_required') {
      const { error: updateErr } = await admin.from('ii_transactions').update({ status: 'parsed' }).eq('id', newTransactionId).eq('user_id', user.id).eq('status', 'review_required');
      if (updateErr) return bad(updateErr.message);
    }
  }
  // 'confirmed_duplicate': the transaction row is intentionally left exactly
  // as it is — already excluded from aggregation, already preserved as
  // evidence. No canonical mutation is needed for this branch beyond
  // resolving the case itself.

  const nowIso = new Date().toISOString();
  const { error: resolveErr } = await admin
    .from('ii_reconciliation_cases')
    .update({
      status: 'resolved',
      resolved_at: nowIso,
      resolution_method: parsed.data.decision === 'confirmed_duplicate' ? 'user_resolved_duplicate' : 'user_classified_transaction',
      resolved_by: user.id,
      resolved_by_actor_type: 'user',
      discrepancy_details: { ...details, userDecision: parsed.data.decision },
    })
    .eq('id', caseId)
    .eq('user_id', user.id)
    .eq('status', 'open');
  if (resolveErr) return bad(resolveErr.message);

  await emitAuditEvent({
    userId: user.id,
    eventType: 'reconciliation_case_resolved',
    subjectType: 'ii_reconciliation_cases',
    subjectId: caseId,
    actorType: 'user',
    actorId: user.id,
    metadata: { reconciliationCaseId: caseId, discrepancyType: existing.discrepancy_type, decision: parsed.data.decision, transactionId: newTransactionId },
  });

  return ok({ caseId, decision: parsed.data.decision, transactionId: newTransactionId });
}
