import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';
import { applyAccountOwnerChange, loadAccountOwnership, loadOwnerChoiceContext } from '@/lib/services/investment-intelligence/accountOwnership';
import { describeOwnership, isOwnerCaseType, ownerChangeRequestSchema, ownershipAuditShape, resolutionMethodFor, validateOwnerSelection } from '@/lib/services/investment-intelligence/ownerModel';
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
 * 'owner_unmatched' / 'owner_mismatch' / 'joint_holding_allocation_required'
 * cases are amended by re-setting the account's owner (as above).
 *
 * 2026-10-01 entity + joint owners: the new owner may be a household member, a
 * business entity (Family Trust / Company / HUF-India-only), or a joint split
 * with percentages (basis points, exactly 10000) -- body
 * `{ owner: {...}, confirm: true }`, the same contract as `PATCH
 * .../accounts/[id]/owner`, validated by the SAME function against rows loaded
 * for this user. The amendment still INSERTS a new, already-resolved case; the
 * amended case row is never touched. A joint-holding case can only be amended
 * to a joint split. Replaying the same amendment is refused with 409
 * already_amended, so it can never create a second allocation set.
 * `ambiguous_instrument` cases (Document2 final
 * closure #3, 2026-09-30) are amended by re-choosing the canonical
 * instrument from the SAME candidate list the original case recorded — the
 * body's discriminant is which field is present (`ownerMemberId` vs
 * `resolvedInstrumentId`), matching `resolvedInstrumentId`'s own one-time
 * resolution route (`reconciliation-cases/[id]/resolve-instrument`) exactly,
 * so there is exactly one validation rule for "which instruments may this
 * case ever resolve to" in the whole module. Other discrepancy types are
 * still shown in history, for a complete record, but with no amend action
 * offered — see the GET .../resolutions route's header.
 */
const instrumentAmendSchema = z.object({ resolvedInstrumentId: z.string().uuid() });

export async function POST(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const rawBody = await req.json().catch(() => null);
  const isInstrumentAmend = !!rawBody && typeof rawBody === 'object' && 'resolvedInstrumentId' in rawBody;
  const instrumentParsed = isInstrumentAmend ? instrumentAmendSchema.safeParse(rawBody) : null;
  if (instrumentParsed && !instrumentParsed.success) return badValidation(instrumentParsed.error, 422);
  const ownerParsed = isInstrumentAmend ? null : ownerChangeRequestSchema.safeParse(rawBody);
  if (ownerParsed && !ownerParsed.success) return badValidation(ownerParsed.error, 422);
  if (ownerParsed?.success && ownerParsed.data.confirm !== true) {
    return bad('Please confirm the owner change before saving it.', 422, 'OWNER_CHANGE_NOT_CONFIRMED');
  }

  const admin = createAdminClient();

  const { data: priorCase } = await admin
    .from('ii_reconciliation_cases')
    .select('id, subject_type, subject_id, discrepancy_type, status, discrepancy_details')
    .eq('id', caseId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!priorCase) return bad('Resolution not found.', 404);
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

  if (instrumentParsed?.success) {
    const parsed = instrumentParsed;
    if (priorCase.discrepancy_type !== 'ambiguous_instrument') return bad('This resolution type cannot be amended here.', 422);
    const details = (priorCase.discrepancy_details as Record<string, unknown> | null) ?? {};
    const candidateInstrumentIds = Array.isArray(details.candidateInstrumentIds) ? (details.candidateInstrumentIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    if (!candidateInstrumentIds.includes(parsed.data.resolvedInstrumentId)) {
      return bad('That instrument is not one of the candidates offered for this issue.', 422);
    }
    const sourceDocumentId = priorCase.subject_id as string;
    const nowIso = new Date().toISOString();
    const previousResolvedInstrumentId = (details.resolvedInstrumentId as string | undefined) ?? null;

    const { data: newCase, error: insertErr } = await admin
      .from('ii_reconciliation_cases')
      .insert({
        user_id: user.id,
        subject_type: priorCase.subject_type,
        subject_id: sourceDocumentId,
        discrepancy_type: 'ambiguous_instrument',
        severity: 'high',
        source_document_id: sourceDocumentId,
        discrepancy_details: { ...details, amendsCaseId: caseId, previousResolvedInstrumentId, resolvedInstrumentId: parsed.data.resolvedInstrumentId, reason: 'User amendment of a prior decision, from the Resolutions history view.' },
        status: 'resolved',
        resolved_at: nowIso,
        resolution_method: 'user_mapped_instrument',
        resolved_by: user.id,
        resolved_by_actor_type: 'user',
      })
      .select('id')
      .single();
    if (insertErr || !newCase) return bad(insertErr?.message ?? 'Could not record the amendment.');

    await emitAuditEvent({
      userId: user.id,
      eventType: 'user_correction',
      subjectType: 'ii_instruments',
      subjectId: parsed.data.resolvedInstrumentId,
      actorType: 'user',
      actorId: user.id,
      metadata: { field: 'ambiguous_instrument', newValue: parsed.data.resolvedInstrumentId, previousValue: previousResolvedInstrumentId, amendsCaseId: caseId, newCaseId: newCase.id },
    });

    let reprocessed = false;
    let reprocessError: string | null = null;
    try {
      const result = await processSourceDocument({ userId: user.id, userEmail: user.email ?? null, sourceDocumentId, forceReparse: true });
      reprocessed = result.ok;
      if (!result.ok) reprocessError = result.error ?? 'Reprocessing did not complete successfully.';
    } catch (e) {
      reprocessError = e instanceof Error ? e.message : 'Reprocessing failed unexpectedly.';
    }

    return ok({ resolvedInstrumentId: parsed.data.resolvedInstrumentId, newCaseId: newCase.id, amendsCaseId: caseId, reprocessed, reprocessError });
  }

  if (!ownerParsed?.success) return bad('This resolution type cannot be amended here.', 422);
  if (priorCase.subject_type !== 'account') return bad('This resolution type cannot be amended here.', 422);
  if (!isOwnerCaseType(priorCase.discrepancy_type)) return bad('This resolution type cannot be amended here.', 422);

  const accountId = priorCase.subject_id as string;
  const currentOwnership = await loadAccountOwnership(admin, user.id, accountId);
  if (!currentOwnership) return bad('Account not found.', 404);

  const userClient = await createClient();
  const ctx = await loadOwnerChoiceContext(user.id, userClient);
  const validated = validateOwnerSelection(ownerParsed.data.owner, ctx);
  if (!validated.ok) return bad(validated.message, validated.status, validated.code);
  if (priorCase.discrepancy_type === 'joint_holding_allocation_required' && validated.owner.kind !== 'joint') {
    return bad('This statement prints a joint holding, so it can only be amended to a joint split between two or more owners.', 422, 'JOINT_CASE_REQUIRES_JOINT_OWNER');
  }

  // Apply the ownership change FIRST: if it is refused (e.g. an entity owner
  // for an already-published account) no amendment row is left behind
  // claiming a decision that did not take effect.
  const applied = await applyAccountOwnerChange({ userId: user.id, accountId, owner: validated.owner, amend: true, caseId });
  if (!applied.ok) return bad(applied.message, applied.status, applied.code);

  const previousOwnerMemberId = currentOwnership.pointerMemberId;
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
        // Legacy member-only keys stay populated for a sole-member result so older readers keep working.
        previousOwnerMemberId,
        resolvedOwnerMemberId: validated.owner.kind === 'member' ? validated.owner.pointerMemberId : null,
        previousOwner: ownershipAuditShape(applied.before),
        resolvedOwner: ownershipAuditShape(applied.after),
        reason: 'User amendment of a prior decision, from the Resolutions history view.',
      },
      status: 'resolved',
      resolved_at: nowIso,
      resolution_method: resolutionMethodFor(validated.owner.kind, true),
      resolved_by: user.id,
      resolved_by_actor_type: 'user',
    })
    .select('id')
    .single();
  if (insertErr || !newCase) return bad(insertErr?.message ?? 'Could not record the amendment. The owner was updated; retry to record it in history.');

  await emitAuditEvent({
    userId: user.id,
    eventType: 'user_correction',
    subjectType: 'ii_reconciliation_cases',
    subjectId: newCase.id as string,
    actorType: 'user',
    actorId: user.id,
    metadata: { field: 'ownership_amendment', amendsCaseId: caseId, newCaseId: newCase.id, accountId, before: ownershipAuditShape(applied.before), after: ownershipAuditShape(applied.after) },
  });

  return ok({
    accountId,
    owner: describeOwnership(applied.after, ctx),
    ownerMemberId: validated.owner.pointerMemberId,
    newCaseId: newCase.id,
    amendsCaseId: caseId,
    changed: applied.changed,
    allocationGroupId: applied.allocationGroupId,
    republishRecommended: applied.republishRecommended,
  });
}
