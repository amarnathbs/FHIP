import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { z } from 'zod';

// Fixes a real, previously unresolvable dead end: an 'owner_unmatched'
// reconciliation case (opened by documentProcessing.ts whenever a statement
// is uploaded with no household member specified) had NO way to actually be
// resolved -- the upload form never collects an owner, and the generic
// "Resolve" button (reconciliation-cases/[id]/resolve) only ever marks a
// case resolved without touching ii_accounts.owner_member_id at all. This
// route is the missing piece: it actually sets the account's real owner,
// then auto-resolves every open 'owner_unmatched' case for that account —
// the correction IS the resolution, not a separate manual step.
//
// 2026-09-28 owner-exception unification: ALSO resolves 'owner_mismatch'
// cases (the statement printed a holder name that did not match the
// declared owner — see documentProcessing.ts's K.7 comparison, reusing
// PC5's ownerMatching.ts). Setting the account's owner here is the correct
// resolution for both case types: 'owner_unmatched' had no owner at all,
// 'owner_mismatch' had one that disagreed with the evidence; in both cases
// the user's fresh choice — confirming the existing assignment despite the
// mismatch, or correcting it to the household member the statement actually
// names — is what should stick. A genuinely PAST (already-resolved) decision
// is never amended through this route — see
// `/api/investment-intelligence/resolutions/[caseId]/amend`, which never
// mutates the original resolved case (its `resolved_at`/`resolution_method`/
// `resolved_by` stay exactly as first recorded, an immutable audit entry)
// and instead inserts a brand-new, already-resolved case referencing the one
// it supersedes.
//
// `discrepancy_details.resolvedOwnerMemberId` is stamped onto the resolved
// case (merged, not overwritten — the original detection evidence such as
// `outcomeKind`/`maskedHolderName`/`candidateMemberIds` stays alongside it)
// so the Resolutions history view can show WHAT was decided, not just THAT
// something was decided.
const setOwnerSchema = z.object({ ownerMemberId: z.string().uuid() });
const RESOLVABLE_BY_OWNER_ASSIGNMENT = ['owner_unmatched', 'owner_mismatch'] as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: accountId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = setOwnerSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);

  const supabase = await createClient();

  const { data: account } = await supabase.from('ii_accounts').select('id').eq('id', accountId).eq('user_id', user.id).maybeSingle();
  if (!account) return bad('Account not found.', 404);

  // Never trust the household member id blindly -- confirm it belongs to
  // this same user before it can ever be attached to their financial data.
  const { data: member } = await supabase.from('household_members').select('id').eq('id', parsed.data.ownerMemberId).eq('user_id', user.id).maybeSingle();
  if (!member) return bad('Household member not found.', 404);

  const { error: updateErr } = await supabase.from('ii_accounts').update({ owner_member_id: parsed.data.ownerMemberId }).eq('id', accountId).eq('user_id', user.id);
  if (updateErr) return bad(updateErr.message);

  const nowIso = new Date().toISOString();

  // ADMIN CLIENT, DELIBERATELY, for every ii_reconciliation_cases read/write
  // below. `discrepancy_details` is a SYSTEM-AUTHORITATIVE column —
  // migration 0087's `ii_reconciliation_cases_assert_authoritative_write()`
  // trigger explicitly refuses any change to it `if auth.role() =
  // 'authenticated'` (found live 2026-09-28: the first version of this fix
  // used the request-scoped RLS client here, which the trigger silently
  // refused — the PATCH returned 200 with `resolvedCaseCount: 0` and no
  // error, because this route never inspected `resolveErr` per-row; the
  // case stayed open with no user-visible signal that anything had failed).
  // Ownership of the target account/household member is already verified
  // above via the RLS-scoped `supabase` client before this point is ever
  // reached, so escalating to admin here for the case write does not widen
  // what this route lets a caller do — it only lets the ALREADY-AUTHORISED
  // action actually persist the one field only the system may set.
  const admin = createAdminClient();

  // Fetch each open, resolvable-by-this-action case's OWN existing details
  // first, so the update below can MERGE resolvedOwnerMemberId into it
  // rather than clobber the detection evidence (outcomeKind, maskedHolderName,
  // candidateMemberIds/matchedMemberId for owner_mismatch) it already carries.
  const { data: openCases, error: openCasesErr } = await admin
    .from('ii_reconciliation_cases')
    .select('id, discrepancy_details')
    .eq('user_id', user.id)
    .eq('subject_type', 'account')
    .eq('subject_id', accountId)
    .in('discrepancy_type', RESOLVABLE_BY_OWNER_ASSIGNMENT)
    .eq('status', 'open');
  if (openCasesErr) return bad(openCasesErr.message);

  let resolvedCaseCount = 0;
  for (const c of openCases ?? []) {
    const mergedDetails = { ...((c.discrepancy_details as Record<string, unknown> | null) ?? {}), resolvedOwnerMemberId: parsed.data.ownerMemberId };
    const { error: resolveErr } = await admin
      .from('ii_reconciliation_cases')
      .update({
        status: 'resolved',
        resolved_at: nowIso,
        resolution_method: 'user_mapped_owner',
        resolved_by: user.id,
        resolved_by_actor_type: 'user',
        discrepancy_details: mergedDetails,
      })
      .eq('id', c.id as string)
      .eq('status', 'open'); // race guard: only this row, only if still open
    if (!resolveErr) resolvedCaseCount++;
  }

  await emitAuditEvent({
    userId: user.id,
    eventType: 'user_correction',
    subjectType: 'ii_accounts',
    subjectId: accountId,
    actorType: 'user',
    actorId: user.id,
    metadata: { field: 'owner_member_id', newValue: parsed.data.ownerMemberId, resolvedCaseCount },
  });

  return ok({ accountId, ownerMemberId: parsed.data.ownerMemberId, resolvedCaseCount });
}
