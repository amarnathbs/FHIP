import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { describeDocumentOwner } from '@/lib/services/investment-intelligence/documentOwner';
import { classifyCase, hasStoredFile } from '@/lib/services/investment-intelligence/caseLifecycle';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import { derivePublicationState, type PublicationState } from '@/lib/investment-intelligence/publicationState';

// R2 — "retrieve parse summary" (spec section 51). Shows exactly what
// spec section 31 requires the minimal UI to display: statement source,
// statement date, accounts/folios found, schemes found, transactions
// found, holdings found, unmatched schemes, reconciliation issues,
// certification status. RLS-respecting client only.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data: doc, error: docErr } = await supabase
    .from('ii_source_documents')
    .select('id, status, source_detected, source_confidence, document_type_detected, statement_period_start, statement_period_end, statement_as_of_date, original_filename, uploaded_at, storage_path, storage_purged_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (docErr) return bad(docErr.message);
  if (!doc) return bad('Source document not found.', 404);

  const [{ data: accounts }, { data: transactions }, { data: holdings }, { data: cases }] = await Promise.all([
    supabase.from('ii_accounts').select('id, folio_number, institution_name').eq('user_id', user.id).eq('source_document_id', id),
    supabase.from('ii_transactions').select('id, account_id, instrument_id').eq('user_id', user.id).eq('source_document_id', id),
    supabase.from('ii_holding_snapshots').select('id, account_id, instrument_id, as_of_date, units, value, quality_status').eq('user_id', user.id).eq('source_document_id', id),
    supabase
      .from('ii_reconciliation_cases')
      .select('id, discrepancy_type, severity, status, subject_type, subject_id, discrepancy_details, opened_at')
      .eq('user_id', user.id)
      .eq('source_document_id', id)
      .order('opened_at', { ascending: false }),
  ]);

  // 2026-09-28 fix, found live during the owner-exception unification pass:
  // `ii_portfolio_truth_status.latest_source_document_id` names whichever
  // document most recently evaluated THIS (account, instrument) position —
  // not necessarily the one currently being viewed. A statement can genuinely
  // hold NO transactions for a position but still record it (e.g. it prints
  // a folio's 0.000 closing balance after a full redemption recorded on an
  // EARLIER document, or this document's own snapshot for a position gets
  // superseded the moment a LATER document re-evaluates the same position).
  // Filtering on `latest_source_document_id = id` made a position's "Re-
  // evaluate" row silently vanish from THIS summary the instant any other
  // document became the position's new "latest" — even though certifying it
  // from this page kept working underneath (last_evaluated_at genuinely
  // advanced every time), the row simply stopped being shown here, which
  // reads identically to "my click did nothing" from this page. Joining
  // instead on "did THIS document ever record a holding snapshot for this
  // position" is the correct question for "should this position's status
  // appear on this document's summary" — it does not depend on which
  // document currently holds the "latest" pointer.
  const positionPairs = new Set((holdings ?? []).map((h) => `${h.account_id as string}:${h.instrument_id as string}`));
  const accountIdsForHoldings = [...new Set((holdings ?? []).map((h) => h.account_id as string))];
  let rawTruthStatuses: {
    account_id: string;
    instrument_id: string;
    status: string;
    blocking_reasons: unknown;
    warning_reasons: unknown;
    history_completeness?: string | null;
    reconciled_closing_units?: number | string | null;
    statement_closing_units?: number | string | null;
    unit_variance?: number | string | null;
    unit_variance_within_tolerance?: boolean | null;
    last_evaluated_at?: string | null;
  }[] = [];
  if (accountIdsForHoldings.length > 0) {
    const { data } = await supabase
      .from('ii_portfolio_truth_status')
      .select('account_id, instrument_id, status, blocking_reasons, warning_reasons, history_completeness, reconciled_closing_units, statement_closing_units, unit_variance, unit_variance_within_tolerance, last_evaluated_at')
      .eq('user_id', user.id)
      .in('account_id', accountIdsForHoldings);
    rawTruthStatuses = (data ?? []).filter((t) => positionPairs.has(`${t.account_id as string}:${t.instrument_id as string}`));
  }

  // 2026-09-28 fix (found live, same pass): the Portfolio Truth list showed
  // "Position a8b86c2e.../42c2515b..." — raw, truncated ids — instead of
  // anything a person could recognise. The account's own `institution_name`/
  // `folio_number` (fetched above) is scoped to accounts THIS document
  // created, which is not always the account a shared position belongs to
  // (see the fix immediately above), so it is re-fetched here by the exact
  // account ids these positions reference; the instrument name is fetched
  // the same way. Both are already-canonical, already-stored fields — no
  // new data is derived, only joined through for display.
  const instrumentIdsForHoldings = [...new Set((holdings ?? []).map((h) => h.instrument_id as string))];
  const [{ data: accountsForPositions }, { data: instrumentsForPositions }] = await Promise.all([
    accountIdsForHoldings.length > 0
      ? supabase.from('ii_accounts').select('id, folio_number, institution_name').eq('user_id', user.id).in('id', accountIdsForHoldings)
      : Promise.resolve({ data: [] as { id: string; folio_number: string | null; institution_name: string }[] }),
    instrumentIdsForHoldings.length > 0 ? supabase.from('ii_instruments').select('id, instrument_name').in('id', instrumentIdsForHoldings) : Promise.resolve({ data: [] as { id: string; instrument_name: string }[] }),
  ]);
  const accountLabelById = new Map((accountsForPositions ?? []).map((a) => [a.id as string, (a.folio_number as string | null) ?? (a.institution_name as string)]));
  const instrumentNameById = new Map((instrumentsForPositions ?? []).map((i) => [i.id as string, i.instrument_name as string]));
  // Document2 (4) WP-B2: per position, the facts the list needs to tell the truth about PUBLICATION (is it already published? is a
  // newer certified statement waiting? what does net worth count today?) and about a UNIT MISMATCH (where the history is missing).
  // The latest snapshot is taken across ALL the person's statements for that position, never just this one: the position's
  // "Publish" target is its latest certified snapshot, and a first-found snapshot of an older statement used to be previewed instead.
  const positions: Record<string, PositionView> = {};
  if (accountIdsForHoldings.length > 0) {
    const [snapshots, txns, pubsRes] = await Promise.all([
      fetchAllRows<{ id: string; account_id: string; instrument_id: string; as_of_date: string; created_at: string | null; value: number | string; currency_code: string }>(() =>
        supabase.from('ii_holding_snapshots').select('id, account_id, instrument_id, as_of_date, created_at, value, currency_code').eq('user_id', user.id).in('account_id', accountIdsForHoldings).order('id', { ascending: true }),
      ),
      fetchAllRows<{ account_id: string; instrument_id: string; transaction_date: string }>(() =>
        supabase.from('ii_transactions').select('account_id, instrument_id, transaction_date').eq('user_id', user.id).in('account_id', accountIdsForHoldings).order('id', { ascending: true }),
      ),
      supabase
        .from('ii_fhip_publications')
        .select('id, account_id, instrument_id, canonical_position_id, published_row_id, published_value, source_currency')
        .eq('user_id', user.id)
        .eq('status', 'published')
        .in('account_id', accountIdsForHoldings),
    ]);
    const pubs = (pubsRes.data ?? []) as { id: string; account_id: string; instrument_id: string; canonical_position_id: string; published_row_id: string | null; published_value: number | string | null; source_currency: string }[];
    const rowIds = pubs.map((p) => p.published_row_id).filter((x): x is string => !!x);
    const counted = new Map<string, number>();
    if (rowIds.length > 0) {
      const { data: invRows } = await supabase.from('investments').select('id, current_value, is_active').eq('user_id', user.id).in('id', rowIds);
      for (const r of (invRows ?? []) as { id: string; current_value: number | string; is_active: boolean | null }[]) if (r.is_active !== false) counted.set(r.id, Number(r.current_value));
    }
    const snapById = new Map(snapshots.map((x) => [x.id, x] as const));
    const latestByPair = new Map<string, (typeof snapshots)[number]>();
    for (const x of snapshots) {
      const k = `${x.account_id}:${x.instrument_id}`;
      const cur = latestByPair.get(k);
      if (!cur || x.as_of_date > cur.as_of_date || (x.as_of_date === cur.as_of_date && String(x.created_at ?? '') > String(cur.created_at ?? ''))) latestByPair.set(k, x);
    }
    const earliestByPair = new Map<string, string>();
    for (const t of txns) {
      const k = `${t.account_id}:${t.instrument_id}`;
      const cur = earliestByPair.get(k);
      if (!cur || t.transaction_date < cur) earliestByPair.set(k, t.transaction_date);
    }
    for (const k of positionPairs) {
      const latest = latestByPair.get(k) ?? null;
      const pub = pubs.find((p) => `${p.account_id}:${p.instrument_id}` === k) ?? null;
      const published = pub ? snapById.get(pub.canonical_position_id) : undefined;
      positions[k] = {
        latestSnapshotId: latest?.id ?? null,
        latestAsOf: latest?.as_of_date ?? null,
        latestStatementValue: latest ? Number(latest.value) : null,
        currency: latest?.currency_code ?? pub?.source_currency ?? null,
        earliestTransactionDate: earliestByPair.get(k) ?? null,
        publication: derivePublicationState(
          pub
            ? {
                publicationId: pub.id,
                canonicalPositionId: pub.canonical_position_id,
                countedValue: pub.published_row_id && counted.has(pub.published_row_id) ? (counted.get(pub.published_row_id) as number) : null,
                publishedValue: pub.published_value == null ? null : Number(pub.published_value),
                currency: pub.source_currency,
                publishedAsOf: published?.as_of_date ?? null,
                publishedCertifiedAt: published?.created_at ?? null,
              }
            : null,
          latest ? { id: latest.id, asOfDate: latest.as_of_date, createdAt: latest.created_at, value: Number(latest.value) } : null,
        ),
      };
    }
  }
  const truthStatuses = rawTruthStatuses.map((t) => ({
    ...t,
    accountLabel: accountLabelById.get(t.account_id) ?? null,
    instrumentName: instrumentNameById.get(t.instrument_id) ?? null,
  }));

  // Owner-before-upload (Phase 1): who this statement was filed under, plus any
  // NON-BLOCKING owner warnings and owner changes still waiting for the user's
  // confirmation. A separate `select('*')`, so a database one migration behind
  // (no owner columns) simply reports nothing chosen at upload.
  const { data: ownerRow } = await supabase.from('ii_source_documents').select('*').eq('id', id).eq('user_id', user.id).maybeSingle();
  const ownerSummary = await describeDocumentOwner(user.id, (ownerRow as Record<string, unknown> | null) ?? null);

  const distinctInstruments = new Set((transactions ?? []).map((t) => t.instrument_id)).size;

  // Document2 (4) WP-B: the raw file is temporary by design, so the screen must be told whether it still exists and what each
  // case really needs (see caseLifecycle.ts). The storage path itself never leaves the server.
  const { storage_path: storagePath, storage_purged_at: storagePurgedAt, ...documentPublic } = doc as typeof doc & { storage_path: string | null; storage_purged_at: string | null };
  const documentState = {
    status: (doc.status as string | null) ?? null,
    storagePath: storagePath ?? null,
    storagePurgedAt: storagePurgedAt ?? null,
    hasRetainedData: (holdings ?? []).length > 0 || (transactions ?? []).length > 0,
  };
  const casesWithLifecycle = (cases ?? []).map((c) => ({ ...c, lifecycle: classifyCase(c.discrepancy_type as string, documentState) }));

  return ok({
    document: documentPublic,
    hasStoredFile: hasStoredFile(documentState),
    accountsFound: (accounts ?? []).length,
    accounts: accounts ?? [],
    schemesFound: distinctInstruments,
    transactionsFound: (transactions ?? []).length,
    holdingsFound: (holdings ?? []).length,
    holdings: holdings ?? [],
    reconciliationCases: casesWithLifecycle,
    openReconciliationCaseCount: (cases ?? []).filter((c) => c.status === 'open' || c.status === 'user_reviewing').length,
    portfolioTruthStatuses: truthStatuses,
    positions,
    owner: ownerSummary,
  });
}

/** What the Portfolio Truth list needs about one position beyond its certification status. */
interface PositionView {
  latestSnapshotId: string | null;
  latestAsOf: string | null;
  latestStatementValue: number | null;
  currency: string | null;
  earliestTransactionDate: string | null;
  publication: PublicationState;
}
