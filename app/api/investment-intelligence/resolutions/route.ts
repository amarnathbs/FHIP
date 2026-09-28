import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * GET /api/investment-intelligence/resolutions — 2026-09-28 owner-exception
 * unification. The "Resolutions" tab's read model: a HISTORY of decided
 * `ii_reconciliation_cases` (status resolved/dismissed), never an active
 * decision surface competing with `/investment-intelligence/review` (that
 * remains the single place OPEN exceptions are decided — see
 * ReviewCentreClient.tsx).
 *
 * WHY THIS QUERIES `ii_reconciliation_cases` DIRECTLY rather than reusing
 * `listReviewItems`/`ii_review_items`: the Review Centre's projection
 * (`detectOpenReconciliationCases`) only ever materialises OPEN cases into
 * `ii_review_items`, and `resolveVanishedItems` marks a review item
 * 'resolved' only once its identity_key stops being produced by a refresh —
 * a derived, lossy signal one refresh cycle behind the real case state, and
 * one that discards which discrepancy_type or account a resolved item was
 * actually about the moment it supersedes. The reconciliation case row
 * itself is the source of truth and is read straight from it here.
 *
 * ONLY 'owner_unmatched' / 'owner_mismatch' cases are amendable in this
 * pass (K.18-style supersession — see the `/amend` route). Other
 * discrepancy types are still shown, for a complete history, but with no
 * amend action offered.
 */
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 50;

  const admin = createAdminClient();
  const { data: cases, error } = await admin
    .from('ii_reconciliation_cases')
    .select('id, subject_type, subject_id, discrepancy_type, status, discrepancy_details, opened_at, resolved_at, resolution_method, resolved_by_actor_type, source_document_id')
    .eq('user_id', user.id)
    .in('status', ['resolved', 'dismissed'])
    .order('resolved_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) return ok({ items: [] });

  const rows = cases ?? [];

  // Resolve human-readable labels: household members referenced anywhere in
  // discrepancy_details (declared/matched/candidate/resolved/previous owner
  // ids) and the accounts these cases are about, so the UI never has to
  // show a bare uuid.
  const memberIds = new Set<string>();
  const accountIds = new Set<string>();
  for (const c of rows) {
    if (c.subject_type === 'account') accountIds.add(c.subject_id as string);
    const details = (c.discrepancy_details as Record<string, unknown> | null) ?? {};
    for (const key of ['declaredOwnerMemberId', 'matchedMemberId', 'resolvedOwnerMemberId', 'previousOwnerMemberId']) {
      const v = details[key];
      if (typeof v === 'string') memberIds.add(v);
    }
    const candidates = details['candidateMemberIds'];
    if (Array.isArray(candidates)) for (const v of candidates) if (typeof v === 'string') memberIds.add(v);
  }

  const [{ data: memberRows }, { data: accountRows }] = await Promise.all([
    memberIds.size > 0
      ? admin.from('household_members').select('id, full_name').eq('user_id', user.id).in('id', [...memberIds])
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    accountIds.size > 0
      ? admin.from('ii_accounts').select('id, folio_number, institution_name, account_number_masked').eq('user_id', user.id).in('id', [...accountIds])
      : Promise.resolve({ data: [] as { id: string; folio_number: string | null; institution_name: string; account_number_masked: string | null }[] }),
  ]);
  const memberNameById = new Map((memberRows ?? []).map((m) => [m.id as string, m.full_name as string]));
  const accountById = new Map((accountRows ?? []).map((a) => [a.id as string, a]));

  // An amendment chain: a case that amends an earlier one carries
  // `discrepancy_details.amendsCaseId`. Compute, for every case in this
  // page, whether a NEWER case in this same page superseded it — so the UI
  // can grey out "Amend" on a row that already has a later decision and
  // link forward to it instead.
  const amendsCaseIdByCaseId = new Map<string, string>();
  for (const c of rows) {
    const amendsCaseId = (c.discrepancy_details as Record<string, unknown> | null)?.['amendsCaseId'];
    if (typeof amendsCaseId === 'string') amendsCaseIdByCaseId.set(c.id as string, amendsCaseId);
  }
  const supersededCaseIds = new Set(amendsCaseIdByCaseId.values());

  const items = rows.map((c) => {
    const details = (c.discrepancy_details as Record<string, unknown> | null) ?? {};
    const account = c.subject_type === 'account' ? accountById.get(c.subject_id as string) : undefined;
    const resolve = (id: unknown) => (typeof id === 'string' ? (memberNameById.get(id) ?? null) : null);
    return {
      id: c.id,
      subjectType: c.subject_type,
      subjectId: c.subject_id,
      discrepancyType: c.discrepancy_type,
      status: c.status,
      openedAt: c.opened_at,
      resolvedAt: c.resolved_at,
      resolutionMethod: c.resolution_method,
      resolvedByActorType: c.resolved_by_actor_type,
      sourceDocumentId: c.source_document_id,
      accountLabel: account ? (account.folio_number ?? account.account_number_masked ?? '(no folio number)') + ' · ' + account.institution_name : null,
      amendable: (c.discrepancy_type === 'owner_unmatched' || c.discrepancy_type === 'owner_mismatch') && c.subject_type === 'account' && !supersededCaseIds.has(c.id as string),
      amendsCaseId: amendsCaseIdByCaseId.get(c.id as string) ?? null,
      isSuperseded: supersededCaseIds.has(c.id as string),
      resolvedOwnerName: resolve(details['resolvedOwnerMemberId']),
      previousOwnerName: resolve(details['previousOwnerMemberId']),
      declaredOwnerName: resolve(details['declaredOwnerMemberId']),
      matchedOwnerName: resolve(details['matchedMemberId']),
      maskedHolderName: typeof details['maskedHolderName'] === 'string' ? details['maskedHolderName'] : null,
      outcomeKind: typeof details['outcomeKind'] === 'string' ? details['outcomeKind'] : null,
      reason: typeof details['reason'] === 'string' ? details['reason'] : null,
    };
  });

  return ok({ items });
}
