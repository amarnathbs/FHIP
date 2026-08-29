import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

// GET /api/financial-data-hub/documents/{documentId}/review-summary — FDH-7
// spec sections 15-19. A concise pre-transaction-review summary. CONSUMES the
// certified reconciliation result exactly as R7/FDH-4/FDH-5 computed it
// (spec 16-17) — this route performs NO arithmetic of its own on
// opening/closing balances or credit/debit totals, only counts existing rows.
export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  interface StatementSummaryRow {
    id: string;
    financial_account_id: string | null;
    institution_id: string | null;
    statement_period_start: string | null;
    statement_period_end: string | null;
    processing_status: string;
    reconciliation_status: string;
    approved_by: string | null;
    approval_version: number;
  }
  const { data: statement, error: stmtError } = await supabase
    .from('fdh_statement_uploads')
    .select(
      'id, financial_account_id, institution_id, statement_period_start, statement_period_end, ' +
        'processing_status, reconciliation_status, approved_by, approval_version',
    )
    .eq('id', documentId)
    .eq('user_id', user.id)
    .maybeSingle<StatementSummaryRow>();
  if (stmtError) return bad('could not load statement', 500);
  if (!statement) return bad('statement not found', 404);

  interface ReconciliationRow {
    opening_balance: number | null;
    extracted_credits: number | null;
    extracted_debits: number | null;
    expected_closing_balance: number | null;
    reported_closing_balance: number | null;
    variance: number | null;
    status: string;
    currency_code: string | null;
  }
  interface TxnCountRow {
    id: string;
    credit_debit: string;
    review_status: string;
    economic_transaction_type: string;
    approval_status: string;
  }
  const [reconciliation, txnCounts, transferOpen, duplicatesOpen] = await Promise.all([
    supabase
      .from('fdh_reconciliation_results')
      .select('opening_balance, extracted_credits, extracted_debits, expected_closing_balance, reported_closing_balance, variance, status, currency_code')
      .eq('user_id', user.id)
      .eq('statement_upload_id', documentId)
      .maybeSingle<ReconciliationRow>(),
    supabase
      .from('fdh_transactions')
      .select('id, credit_debit, review_status, economic_transaction_type, approval_status', { count: 'exact', head: false })
      .eq('user_id', user.id)
      .eq('statement_upload_id', documentId)
      .returns<TxnCountRow[]>(),
    supabase
      .from('fdh_transaction_links')
      .select('id, transaction_id_from, transaction_id_to', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .in('link_type', ['internal_transfer', 'credit_card_settlement']),
    supabase
      .from('fdh_duplicate_candidates')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('status', 'pending'),
  ]);

  const txns = txnCounts.data ?? [];
  const credits = txns.filter((t) => t.credit_debit === 'credit').length;
  const debits = txns.filter((t) => t.credit_debit === 'debit').length;
  const needsReview = txns.filter((t) => t.review_status === 'pending' || t.review_status === 'in_review').length;
  const unknownClassification = txns.filter((t) => t.economic_transaction_type === 'unknown').length;
  const approved = txns.filter((t) => t.approval_status === 'approved').length;

  return ok({
    statement_id: statement.id,
    financial_account_id: statement.financial_account_id,
    institution_id: statement.institution_id,
    statement_period_start: statement.statement_period_start,
    statement_period_end: statement.statement_period_end,
    processing_status: statement.processing_status,
    genuinely_user_approved: Boolean(statement.approved_by),
    approval_version: statement.approval_version,
    transactions_found: txns.length,
    credits,
    debits,
    // Consumed exactly as computed — no recalculation (spec 17).
    reconciliation: reconciliation.data
      ? {
          opening_balance: reconciliation.data.opening_balance,
          extracted_credits: reconciliation.data.extracted_credits,
          extracted_debits: reconciliation.data.extracted_debits,
          expected_closing_balance: reconciliation.data.expected_closing_balance,
          reported_closing_balance: reconciliation.data.reported_closing_balance,
          variance: reconciliation.data.variance,
          status: reconciliation.data.status,
          currency_code: reconciliation.data.currency_code,
        }
      : { status: 'not_available' }, // honest, never presented as reconciled (spec 19)
    transactions_requiring_review: needsReview,
    transactions_approved: approved,
    transfers_needing_attention: transferOpen.count ?? 0,
    duplicates_needing_attention: duplicatesOpen.count ?? 0,
    unknown_classifications: unknownClassification,
  });
}
