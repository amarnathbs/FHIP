import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

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
    .select('id, status, source_detected, source_confidence, document_type_detected, statement_period_start, statement_period_end, statement_as_of_date, original_filename, uploaded_at')
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
  let truthStatuses: { account_id: string; instrument_id: string; status: string; blocking_reasons: unknown; warning_reasons: unknown }[] = [];
  if (accountIdsForHoldings.length > 0) {
    const { data } = await supabase
      .from('ii_portfolio_truth_status')
      .select('account_id, instrument_id, status, blocking_reasons, warning_reasons')
      .eq('user_id', user.id)
      .in('account_id', accountIdsForHoldings);
    truthStatuses = (data ?? []).filter((t) => positionPairs.has(`${t.account_id as string}:${t.instrument_id as string}`));
  }

  const distinctInstruments = new Set((transactions ?? []).map((t) => t.instrument_id)).size;

  return ok({
    document: doc,
    accountsFound: (accounts ?? []).length,
    accounts: accounts ?? [],
    schemesFound: distinctInstruments,
    transactionsFound: (transactions ?? []).length,
    holdingsFound: (holdings ?? []).length,
    holdings: holdings ?? [],
    reconciliationCases: cases ?? [],
    openReconciliationCaseCount: (cases ?? []).filter((c) => c.status === 'open' || c.status === 'user_reviewing').length,
    portfolioTruthStatuses: truthStatuses ?? [],
  });
}
