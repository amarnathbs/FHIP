import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { z } from 'zod';

/**
 * POST /api/investment-intelligence/resolutions/[caseId]/amend —
 * 2026-09-28 owner-exception unification, the "Resolutions" tab's amend
 * action (item 4 of the Product Owner's decision: "allow the user to amend
 * a past decision later ... re-resolve it, which should trigger the same
 * downstream re-reconciliation PC5's own K.19/reReconciliation.ts models:
 * never delete a record, a new decision supersedes the old one, full audit
 * trail").
 *
 * WHAT THIS DOES NOT DO: mutate the case being amended. `caseId` must
 * already be TERMINAL (resolved/dismissed) — its own resolved_at/
 * resolution_method/resolved_by stay exactly as first recorded, forever, as
 * the immutable record of the first decision. This route instead INSERTS a
 * brand-new `ii_reconciliation_cases` row, already resolved, carrying
 * `discrepancy_details.amendsCaseId` back to the one it supersedes and
 * `previousOwnerMemberId` (what the account's owner was immediately before
 * this amendment) — the same append-only, never-overwrite discipline PC5's
 * own `recordReviewDecision` uses for `aie_review_decision` (see
 * PC5_IMPLEMENTATION_CERTIFICATION_2026-09-15.md, K.18), applied to this
 * table instead since this pipeline was never wired to PC5's.
 *
 * RE-RECONCILIATION: unlike PC5's `aie_unresolved_item` items, an
 * `ii_reconciliation_cases` owner exception has no separate "downstream
 * blocking" state machine to re-check — `ii_accounts.owner_member_id` IS
 * the fact in question, and this route updates it directly (same effect
 * the first-time `PATCH .../accounts/[id]/owner` resolution has). There is
 * therefore nothing further to "re-run": the account's owner changes
 * immediately and every reader of it (net worth, publications, the Review
 * Centre's own next refresh) sees the corrected value on its next read,
 * exactly as it would after the original resolution.
 *
 * Only 'owner_unmatched' / 'owner_mismatch' cases are amendable in this
 * pass — see the GET .../resolutions route's header for why other
 * discrepancy types are shown in history but not offered this action.
 */
const amendSchema = z.object({ ownerMemberId: z.string().uuid() });
const AMENDABLE_DISCREPANCY_TYPES = ['owner_unmatched', 'owner_mismatch'] as const;

export async function POST(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = amendSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);

  const admin = createAdminClient();

  const { data: priorCase } = await admin
    .from('ii_reconciliation_cases')
    .select('id, subject_type, subject_id, discrepancy_type, status, discrepancy_details')
    .eq('id', caseId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!priorCase) return bad('Resolution not found.', 404);
  if (priorCase.subject_type !== 'account') return bad('This resolution type cannot be amended here.', 422);
  if (!AMENDABLE_DISCREPANCY_TYPES.includes(priorCase.discrepancy_type as (typeof AMENDABLE_DISCREPANCY_TYPES)[number])) {
    return bad('This resolution type cannot be amended here.', 422);
  }
  if (priorCase.status !== 'resolved' && priorCase.status !== 'dismissed') {
    return bad('Only a decided (resolved or dismissed) case can be amended. An open case should be decided from the Review tab instead.', 422);
  }

  // A case that has ALREADY been amended once must not be amended again
  // from here — the newer case is the current decision; amend THAT one.
  const { data: newerAmendment } = await admin
    .from('ii_reconciliation_cases')
    .select('id')
    .eq('user_id', user.id)
    .contains('discrepancy_details', { amendsCaseId: caseId })
    .limit(1)
    .maybeSingle();
  if (newerAmendment) return bad('This decision has already been amended by a later one. Amend the most recent decision instead.', 409, 'already_amended');

  const accountId = priorCase.subject_id as string;
  const { data: account } = await admin.from('ii_accounts').select('id, owner_member_id').eq('id', accountId).eq('user_id', user.id).maybeSingle();
  if (!account) return bad('Account not found.', 404);

  const { data: member } = await admin.from('household_members').select('id').eq('id', parsed.data.ownerMemberId).eq('user_id', user.id).maybeSingle();
  if (!member) return bad('Household member not found.', 404);

  const previousOwnerMemberId = (account.owner_member_id as string | null) ?? null;
  const nowIso = new Date().toISOString();

  const { data: newCase, error: insertErr } = await admin
    .from('ii_reconciliation_cases')
    .insert({
      user_id: user.id,
      subject_type: 'account',
      subject_id: accountId,
      discrepancy_type: priorCase.discrepancy_type,
      severity: 'blocking',
      source_document_id: null,
      discrepancy_details: {
        ...((priorCase.discrepancy_details as Record<string, unknown> | null) ?? {}),
        amendsCaseId: caseId,
        previousOwnerMemberId,
        resolvedOwnerMemberId: parsed.data.ownerMemberId,
        reason: 'User amendment of a prior decision, from the Resolutions history view.',
      },
      status: 'resolved',
      resolved_at: nowIso,
      resolution_method: 'user_amended_owner',
      resolved_by: user.id,
      resolved_by_actor_type: 'user',
    })
    .select('id')
    .single();
  if (insertErr || !newCase) return bad(insertErr?.message ?? 'Could not record the amendment.');

  const { error: updateErr } = await admin.from('ii_accounts').update({ owner_member_id: parsed.data.ownerMemberId }).eq('id', accountId).eq('user_id', user.id);
  if (updateErr) return bad(updateErr.message);

  await emitAuditEvent({
    userId: user.id,
    eventType: 'user_correction',
    subjectType: 'ii_accounts',
    subjectId: accountId,
    actorType: 'user',
    actorId: user.id,
    metadata: { field: 'owner_member_id', newValue: parsed.data.ownerMemberId, previousValue: previousOwnerMemberId, amendsCaseId: caseId, newCaseId: newCase.id },
  });

  return ok({ accountId, ownerMemberId: parsed.data.ownerMemberId, newCaseId: newCase.id, amendsCaseId: caseId });
}
