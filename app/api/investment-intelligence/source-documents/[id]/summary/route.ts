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

  const [{ data: accounts }, { data: transactions }, { data: holdings }, { data: cases }, { data: truthStatuses }] = await Promise.all([
    supabase.from('ii_accounts').select('id, folio_number, institution_name').eq('user_id', user.id).eq('source_document_id', id),
    supabase.from('ii_transactions').select('id, account_id, instrument_id').eq('user_id', user.id).eq('source_document_id', id),
    supabase.from('ii_holding_snapshots').select('id, account_id, instrument_id, as_of_date, units, value, quality_status').eq('user_id', user.id).eq('source_document_id', id),
    supabase
      .from('ii_reconciliation_cases')
      .select('id, discrepancy_type, severity, status, subject_type, subject_id, discrepancy_details, opened_at')
      .eq('user_id', user.id)
      .eq('source_document_id', id)
      .order('opened_at', { ascending: false }),
    supabase.from('ii_portfolio_truth_status').select('account_id, instrument_id, status, blocking_reasons, warning_reasons').eq('user_id', user.id).eq('latest_source_document_id', id),
  ]);

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
