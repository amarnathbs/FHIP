import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { applyAccountOwnerChange, loadAccountOwnership, loadOwnerChoiceContext } from '@/lib/services/investment-intelligence/accountOwnership';
import { buildOwnerOptions, describeOwnership, isOwnerCaseType, ownerChangeRequestSchema, validateOwnerSelection } from '@/lib/services/investment-intelligence/ownerModel';

// Fixes a real, previously unresolvable dead end: an 'owner_unmatched'
// reconciliation case (opened by documentProcessing.ts whenever a statement
// is uploaded with no household member specified) had NO way to actually be
// resolved -- the upload form never collects an owner, and the generic
// "Resolve" button (reconciliation-cases/[id]/resolve) only ever marks a
// case resolved without touching ii_accounts.owner_member_id at all. This
// route is the missing piece: it actually sets the account's real owner,
// then auto-resolves every open owner-exception case for that account — the
// correction IS the resolution, not a separate manual step.
//
// 2026-09-28 owner-exception unification: ALSO resolves 'owner_mismatch'
// cases (the statement printed a holder name that did not match the
// declared owner — see documentProcessing.ts's K.7 comparison, reusing
// PC5's ownerMatching.ts). A genuinely PAST (already-resolved) decision is
// never amended through this route — see
// `/api/investment-intelligence/resolutions/[caseId]/amend`, which never
// mutates the original resolved case and inserts a brand-new, already-
// resolved case referencing the one it supersedes.
//
// 2026-10-01 entity + joint owners (PO request: "an option to change the owner
// to a Trust, HUF or Company, and any way to enter a joint split with
// percentages"). The owner is now one of:
//   { kind: 'member', member_id }
//   { kind: 'entity', business_entity_id }            Family Trust / Company / HUF (India only)
//   { kind: 'joint',  allocations: [{ member_id | business_entity_id, basis_points }] }
// and the request must carry `confirm: true` (the UI's explicit confirmation
// step; a request without it is refused, never assumed). Every owner id is
// re-validated here against rows loaded for THIS user, and the HUF gate reads
// the caller's AUTHORITATIVE home country (user_profiles) -- never the body.
// A joint-holding case (`joint_holding_allocation_required`) is resolved ONLY
// by a joint split. The legacy body `{ ownerMemberId }` is still understood
// (mapped to kind 'member') but needs `confirm: true` like everything else.
// Design, consumers and tests: docs/ownership/OWNER_ENTITY_JOINT_EDIT_REPORT.md.

/**
 * GET -- what the owner-change dialog needs: the account's CURRENT owner (with
 * readable labels), and the owners this user may pick from (country-gated).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: accountId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const admin = createAdminClient();
  const current = await loadAccountOwnership(admin, user.id, accountId);
  if (!current) return bad('Account not found.', 404);

  const userClient = await createClient();
  const ctx = await loadOwnerChoiceContext(user.id, userClient);
  const { options, jointAvailable } = buildOwnerOptions(ctx);
  const { data: publications } = await admin.from('ii_fhip_publications').select('id').eq('user_id', user.id).eq('account_id', accountId).eq('status', 'published').limit(1);

  return ok({
    accountId,
    current: describeOwnership(current.ownership, ctx),
    options,
    jointAvailable,
    published: (publications ?? []).length > 0,
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: accountId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = ownerChangeRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);
  if (parsed.data.confirm !== true) {
    return bad('Please confirm the owner change before saving it.', 422, 'OWNER_CHANGE_NOT_CONFIRMED');
  }

  const admin = createAdminClient();
  const current = await loadAccountOwnership(admin, user.id, accountId);
  if (!current) return bad('Account not found.', 404);

  const userClient = await createClient();
  const ctx = await loadOwnerChoiceContext(user.id, userClient);
  const validated = validateOwnerSelection(parsed.data.owner, ctx);
  if (!validated.ok) return bad(validated.message, validated.status, validated.code);

  // When the caller says WHICH case this is resolving, hold it to the case's
  // own rule: a joint holding can only be resolved by a joint split.
  let caseId: string | null = null;
  if (parsed.data.case_id) {
    const { data: theCase } = await admin
      .from('ii_reconciliation_cases')
      .select('id, discrepancy_type, subject_type, subject_id, status')
      .eq('id', parsed.data.case_id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!theCase || theCase.subject_type !== 'account' || theCase.subject_id !== accountId || !isOwnerCaseType(theCase.discrepancy_type)) {
      return bad('That issue was not found for this account.', 404, 'CASE_NOT_FOUND');
    }
    if (theCase.discrepancy_type === 'joint_holding_allocation_required' && validated.owner.kind !== 'joint') {
      return bad('This statement prints a joint holding, so it can only be resolved with a joint split between two or more owners.', 422, 'JOINT_CASE_REQUIRES_JOINT_OWNER');
    }
    caseId = theCase.id as string;
  }

  const result = await applyAccountOwnerChange({ userId: user.id, accountId, owner: validated.owner, amend: false, caseId });
  if (!result.ok) return bad(result.message, result.status, result.code);

  return ok({
    accountId,
    owner: describeOwnership(result.after, ctx),
    // Back-compat for the pre-2026-10-01 client: the sole member's id, when there is one.
    ownerMemberId: validated.owner.pointerMemberId,
    changed: result.changed,
    resolvedCaseCount: result.resolvedCaseIds.length,
    allocationGroupId: result.allocationGroupId,
    republishRecommended: result.republishRecommended,
  });
}
