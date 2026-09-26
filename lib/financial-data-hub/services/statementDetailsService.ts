/**
 * WP-08 (EXP-G14, D-04): everything an imported bank statement says, visible
 * to its owner -- the evidence side of the field-disposition registry.
 *
 * Before, posting date, value date, bank reference, running balance, the
 * reconciliation and the opening / closing balance were stored and never
 * shown anywhere, and the lines that could not be read vanished without a
 * reason. The statement details drawer (components/financial-data-hub/
 * StatementDetailsDrawer.tsx) renders exactly this payload.
 *
 * Read-only. Every query uses the RLS-scoped session client AND an explicit
 * `user_id` filter; another user's statement id is simply not found.
 */

import { createClient } from '@/lib/supabase/server';
import { buildStatementNotes, type StatementNote, type StatementReviewItemRow } from '../domain/categoryReview';
import { decodeUnreadLines, describeUnreadLines, type UnreadLinesSummary } from '../domain/unreadLines';

export class StatementDetailsError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_state', message: string) {
    super(message);
    this.name = 'StatementDetailsError';
  }
}

export const STATEMENT_DETAILS_PAGE_SIZE = 100;

/** D-04: the bank closing balance is evidence until the user applies it as a
 * cash asset (that proposal is WP-15's); the label says so. */
export const CLOSING_BALANCE_LABEL = 'Closing balance on this statement (not in your Net Worth unless you add it as a cash asset)';

const QUALITY_TEXT: Record<string, Partial<Record<string, string>> & { default: string }> = {
  transaction_count_valid: { pass: 'Every line on the statement was read.', default: 'Some lines on the statement could not be read.' },
  account_identified: {
    pass: 'The statement is attached to one of your accounts.',
    warning: 'The account number on the statement does not match the account it was attached to.',
    default: 'We could not tell which account this statement belongs to.',
  },
  balance_reconciled: {
    pass: 'The transactions add up to the statement\'s closing balance.',
    not_applicable: 'The statement does not print balances we could check the transactions against.',
    default: 'The transactions do not add up to the statement\'s closing balance.',
  },
  statement_period_found: { pass: 'The statement period was found.', default: 'The statement period was not found.' },
  duplicate_file: { pass: 'This file was not uploaded before.', default: 'This file was uploaded before.' },
  low_extraction_confidence: {
    pass: 'The AI reading reported no problems.',
    default: 'The AI reading reported that it may be incomplete or uncertain. Check it against your statement.',
  },
};

export interface StatementDetailLine {
  id: string;
  transaction_date: string;
  posting_date: string | null;
  value_date: string | null;
  description: string | null;
  reference: string | null;
  amount: number;
  currency: string;
  credit_debit: 'credit' | 'debit';
  balance_after: number | null;
  economic_transaction_type: string;
  approval_status: string;
  dedup_status: string;
}

export interface StatementDetails {
  statement: {
    id: string;
    file_name: string | null;
    source_type: string | null;
    period_start: string | null;
    period_end: string | null;
    currency: string | null;
    processing_status: string;
    certification_status: string | null;
    approved: boolean;
    account: { id: string; display_name: string | null; masked_identifier: string | null; owner_role: string | null } | null;
  };
  reconciliation: {
    status: string;
    opening_balance: number | null;
    closing_balance: number | null;
    expected_closing_balance: number | null;
    variance: number | null;
    currency: string | null;
  };
  closing_balance_label: string;
  quality: Array<{ check_code: string; status: string; text: string }>;
  unread_lines: UnreadLinesSummary | null;
  unread_lines_text: string | null;
  notes: StatementNote[];
  lines: { rows: StatementDetailLine[]; total: number; page: number; page_size: number };
}

const n = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export async function getStatementDetails(userId: string, statementId: string, page = 1): Promise<StatementDetails> {
  const supabase = await createClient();
  const { data: statement, error } = await supabase
    .from('fdh_statement_uploads')
    .select('id, financial_account_id, original_filename_sanitised, source_type, statement_period_start, statement_period_end, currency_code, processing_status, certification_status, approved_by')
    .eq('id', statementId)
    .eq('user_id', userId)
    .maybeSingle<{
      id: string; financial_account_id: string | null; original_filename_sanitised: string | null; source_type: string | null;
      statement_period_start: string | null; statement_period_end: string | null; currency_code: string | null;
      processing_status: string; certification_status: string | null; approved_by: string | null;
    }>();
  if (error) throw new StatementDetailsError('invalid_state', 'We could not load this statement.');
  if (!statement) throw new StatementDetailsError('not_found', 'This statement was not found.');

  const safePage = Math.max(1, Math.floor(page) || 1);
  const from = (safePage - 1) * STATEMENT_DETAILS_PAGE_SIZE;

  const [account, recon, quality, items, lines] = await Promise.all([
    statement.financial_account_id
      // '*' so a database without migration 0207 (no owner_role) still works.
      ? supabase.from('fdh_financial_accounts').select('*').eq('id', statement.financial_account_id).eq('user_id', userId).maybeSingle<Record<string, unknown>>()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from('fdh_reconciliation_results')
      .select('status, opening_balance, reported_closing_balance, expected_closing_balance, variance, currency_code')
      .eq('user_id', userId)
      .eq('statement_upload_id', statementId)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase.from('fdh_data_quality_results').select('check_code, status, details_sanitised').eq('user_id', userId).eq('statement_upload_id', statementId).order('check_code', { ascending: true }),
    supabase
      .from('fdh_review_items')
      .select('id, severity, title_code, context_json')
      .eq('user_id', userId)
      .eq('statement_upload_id', statementId)
      .is('transaction_id', null)
      .in('status', ['open', 'in_progress'])
      .order('id', { ascending: true }),
    supabase
      .from('fdh_transactions')
      .select('id, transaction_date, posting_date, value_date, description_clean, source_reference, amount_original, currency_original, credit_debit, balance_after, economic_transaction_type, approval_status, dedup_status', { count: 'exact' })
      .eq('user_id', userId)
      .eq('statement_upload_id', statementId)
      .order('transaction_date', { ascending: true })
      .order('source_row', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + STATEMENT_DETAILS_PAGE_SIZE - 1),
  ]);
  for (const r of [account, recon, quality, items, lines]) {
    if (r.error) throw new StatementDetailsError('invalid_state', 'We could not load this statement.');
  }

  const acc = account.data as Record<string, unknown> | null;
  const rec = ((recon.data ?? []) as Array<Record<string, unknown>>)[0] ?? null;
  const dq = (quality.data ?? []) as Array<{ check_code: string; status: string; details_sanitised: string | null }>;
  const countRow = dq.find((q) => q.check_code === 'transaction_count_valid');
  const unread = decodeUnreadLines(countRow?.details_sanitised);

  return {
    statement: {
      id: statement.id,
      file_name: statement.original_filename_sanitised,
      source_type: statement.source_type,
      period_start: statement.statement_period_start,
      period_end: statement.statement_period_end,
      currency: statement.currency_code,
      processing_status: statement.processing_status,
      certification_status: statement.certification_status,
      approved: Boolean(statement.approved_by),
      account: acc
        ? {
            id: String(acc.id),
            display_name: (acc.display_name as string | null) ?? null,
            masked_identifier: (acc.masked_identifier as string | null) ?? null,
            owner_role: (acc.owner_role as string | null | undefined) ?? null,
          }
        : null,
    },
    reconciliation: {
      status: rec ? String(rec.status) : 'not_available',
      opening_balance: n(rec?.opening_balance),
      closing_balance: n(rec?.reported_closing_balance),
      expected_closing_balance: n(rec?.expected_closing_balance),
      variance: n(rec?.variance),
      currency: (rec?.currency_code as string | null | undefined) ?? statement.currency_code,
    },
    closing_balance_label: CLOSING_BALANCE_LABEL,
    quality: dq.map((q) => ({ check_code: q.check_code, status: q.status, text: QUALITY_TEXT[q.check_code]?.[q.status] ?? QUALITY_TEXT[q.check_code]?.default ?? q.check_code })),
    unread_lines: unread,
    unread_lines_text: unread ? describeUnreadLines(unread) : null,
    notes: buildStatementNotes((items.data ?? []) as StatementReviewItemRow[]),
    lines: {
      rows: ((lines.data ?? []) as Array<Record<string, unknown>>).map((t) => ({
        id: String(t.id),
        transaction_date: String(t.transaction_date),
        posting_date: (t.posting_date as string | null) ?? null,
        value_date: (t.value_date as string | null) ?? null,
        description: (t.description_clean as string | null) ?? null,
        reference: (t.source_reference as string | null) ?? null,
        amount: Number(t.amount_original),
        currency: String(t.currency_original),
        credit_debit: t.credit_debit as 'credit' | 'debit',
        balance_after: n(t.balance_after),
        economic_transaction_type: String(t.economic_transaction_type),
        approval_status: String(t.approval_status),
        dedup_status: String(t.dedup_status),
      })),
      total: lines.count ?? 0,
      page: safePage,
      page_size: STATEMENT_DETAILS_PAGE_SIZE,
    },
  };
}
