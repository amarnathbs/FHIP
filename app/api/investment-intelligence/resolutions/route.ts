import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { describeOwnership, type AccountOwnership, type OwnerChoiceContext } from '@/lib/services/investment-intelligence/ownerModel';

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
 * 2026-10-01: a decided owner may now be a business entity or a joint split
 * (stored as `discrepancy_details.resolvedOwner` / `previousOwner`: ids and
 * basis points only). This route resolves their LABELS here, per request, from
 * the caller's own members/entities -- names are never stored on the case.
 * 'joint_holding_allocation_required' cases are amendable too (to a joint split).
 *
 * 'owner_unmatched' / 'owner_mismatch' / 'ambiguous_instrument' cases are
 * amendable (K.18-style supersession — see the `/amend` route; the
 * `ambiguous_instrument` amend path was added 2026-09-30, Document2 final
 * non-benchmark closure #3). Other discrepancy types are still shown, for a
 * complete history, but with no amend action offered.
 */
/** Reads the id + basis-point shares out of a stored `resolvedOwner` / `previousOwner` audit shape. */
function sharesOf(value: unknown): { memberId?: string; businessEntityId?: string; basisPoints: number }[] {
  const shares = (value as { shares?: unknown } | null)?.shares;
  if (!Array.isArray(shares)) return [];
  const out: { memberId?: string; businessEntityId?: string; basisPoints: number }[] = [];
  for (const s of shares) {
    const o = s as { memberId?: unknown; businessEntityId?: unknown; basisPoints?: unknown };
    if (typeof o.basisPoints !== 'number') continue;
    if (typeof o.memberId === 'string') out.push({ memberId: o.memberId, basisPoints: o.basisPoints });
    else if (typeof o.businessEntityId === 'string') out.push({ businessEntityId: o.businessEntityId, basisPoints: o.basisPoints });
  }
  return out;
}

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
  const entityIds = new Set<string>();
  const accountIds = new Set<string>();
  for (const c of rows) {
    if (c.subject_type === 'account') accountIds.add(c.subject_id as string);
    const details = (c.discrepancy_details as Record<string, unknown> | null) ?? {};
    for (const key of ['resolvedOwner', 'previousOwner']) {
      for (const share of sharesOf(details[key])) {
        if (share.memberId) memberIds.add(share.memberId);
        if (share.businessEntityId) entityIds.add(share.businessEntityId);
      }
    }
    for (const key of ['declaredOwnerMemberId', 'matchedMemberId', 'resolvedOwnerMemberId', 'previousOwnerMemberId']) {
      const v = details[key];
      if (typeof v === 'string') memberIds.add(v);
    }
    const candidates = details['candidateMemberIds'];
    if (Array.isArray(candidates)) for (const v of candidates) if (typeof v === 'string') memberIds.add(v);
  }

  const [{ data: memberRows }, { data: entityRows }, { data: accountRows }] = await Promise.all([
    memberIds.size > 0
      ? admin.from('household_members').select('id, full_name, relationship, is_active').eq('user_id', user.id).in('id', [...memberIds])
      : Promise.resolve({ data: [] as { id: string; full_name: string; relationship: string; is_active: boolean }[] }),
    entityIds.size > 0
      ? admin.from('business_entities').select('id, name, entity_type, is_active').eq('user_id', user.id).in('id', [...entityIds])
      : Promise.resolve({ data: [] as { id: string; name: string; entity_type: string; is_active: boolean }[] }),
    accountIds.size > 0
      ? admin.from('ii_accounts').select('id, folio_number, institution_name, account_number_masked, currency_code').eq('user_id', user.id).in('id', [...accountIds])
      : Promise.resolve({
          data: [] as { id: string; folio_number: string | null; institution_name: string; account_number_masked: string | null; currency_code: string }[],
        }),
  ]);
  const memberNameById = new Map((memberRows ?? []).map((m) => [m.id as string, m.full_name as string]));
  const labelCtx: OwnerChoiceContext = {
    members: (memberRows ?? []) as OwnerChoiceContext['members'],
    entities: (entityRows ?? []) as OwnerChoiceContext['entities'],
    homeCountry: null,
  };
  const ownerViewOf = (value: unknown) => {
    const shares = sharesOf(value);
    if (shares.length === 0) return null;
    const kind = shares.length > 1 ? 'joint' : shares[0].businessEntityId ? 'entity' : 'member';
    const ownership: AccountOwnership = { kind, shares, hasEntity: shares.some((s) => !!s.businessEntityId) };
    return describeOwnership(ownership, labelCtx);
  };
  const summarise = (view: ReturnType<typeof ownerViewOf>) =>
    !view ? null : view.kind === 'joint' ? view.owners.map((o) => `${o.label} ${(o.basisPoints / 100).toFixed(2)}%`).join(' / ') : (view.owners[0]?.label ?? null);
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
      // 2026-09-30: the account's own currency, threaded through the same
      // way every other Investment Intelligence component sources its
      // date-formatting currency (see dateDisplay.ts) -- ResolutionHistoryClient
      // uses this for fmtDate()/fmtDateTime() instead of the browser's default
      // locale format. Only ever set for subject_type='account' cases, which
      // is every amendable case and the large majority of this history view;
      // fmtDate()/fmtDateTime() fall back to AUD when it's null, same as
      // every other caller with no currency context.
      accountCurrencyCode: account?.currency_code ?? null,
      amendable:
        (((c.discrepancy_type === 'owner_unmatched' || c.discrepancy_type === 'owner_mismatch' || c.discrepancy_type === 'joint_holding_allocation_required') && c.subject_type === 'account') ||
          c.discrepancy_type === 'ambiguous_instrument') &&
        !supersededCaseIds.has(c.id as string),
      amendsCaseId: amendsCaseIdByCaseId.get(c.id as string) ?? null,
      isSuperseded: supersededCaseIds.has(c.id as string),
      // `resolvedOwner` / `previousOwner` (2026-10-01) carry member, entity and
      // joint results; the legacy single-member keys remain the fallback for
      // decisions recorded before then. `*OwnerName` is a ready-to-show summary
      // ("Smith Family Trust", "A 60.00% / B 40.00%") so older UI keeps working.
      resolvedOwner: ownerViewOf(details['resolvedOwner']),
      previousOwner: ownerViewOf(details['previousOwner']),
      resolvedOwnerName: summarise(ownerViewOf(details['resolvedOwner'])) ?? resolve(details['resolvedOwnerMemberId']),
      previousOwnerName: summarise(ownerViewOf(details['previousOwner'])) ?? resolve(details['previousOwnerMemberId']),
      matchedMemberIds: Array.isArray(details['matchedMemberIds']) ? (details['matchedMemberIds'] as unknown[]).filter((v): v is string => typeof v === 'string') : [],
      maskedJointHolders: Array.isArray(details['maskedJointHolders']) ? (details['maskedJointHolders'] as unknown[]).filter((v): v is string => typeof v === 'string') : [],
      declaredOwnerName: resolve(details['declaredOwnerMemberId']),
      matchedOwnerName: resolve(details['matchedMemberId']),
      maskedHolderName: typeof details['maskedHolderName'] === 'string' ? details['maskedHolderName'] : null,
      outcomeKind: typeof details['outcomeKind'] === 'string' ? details['outcomeKind'] : null,
      reason: typeof details['reason'] === 'string' ? details['reason'] : null,
      // Document2 final closure #3 — 'ambiguous_instrument' friendly display,
      // never a raw instrument id: `candidates` was recorded with real
      // display names at case-creation time (see
      // documentProcessing.ts/aiExtractionReviewApply.ts), so no extra join
      // is needed to resolve `resolvedInstrumentId` into a name here.
      schemeName: typeof details['scheme'] === 'string' ? details['scheme'] : null,
      candidateInstruments: Array.isArray(details['candidates']) ? (details['candidates'] as unknown[]) : [],
      resolvedInstrumentName:
        c.discrepancy_type === 'ambiguous_instrument' && typeof details['resolvedInstrumentId'] === 'string'
          ? (((details['candidates'] as { instrumentId: string; displayName: string }[] | undefined) ?? []).find((cand) => cand.instrumentId === details['resolvedInstrumentId'])?.displayName ?? null)
          : null,
    };
  });

  return ok({ items });
}
