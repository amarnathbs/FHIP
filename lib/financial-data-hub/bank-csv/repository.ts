/**
 * R7 — Bank CSV Engine: paginated read helpers over existing FDH data.
 *
 * PAGINATION DISCIPLINE (spec section 76). Every read here that could return
 * more than one PostgREST page (1000 rows) goes through `fetchAllRows()`
 * (`./pagination.ts`) — the FDH module's own copy of the identical contract
 * Investment Intelligence R4/R5/R6 converged on after finding the same
 * silent-truncation defect three times independently (duplicated rather
 * than imported — see `pagination.ts`'s header for why). Ordering always
 * includes a unique tie-breaker (`id`), never a bare non-unique column.
 */

import { createClient } from '@/lib/supabase/server';
import { fetchAllRows } from './pagination';
import type { DedupIndex } from './dedup';
import type { ExistingAccountSummary } from './accountIdentity';
import type { DateRange } from './reconciliation';

interface FingerprintRow {
  id: string;
  economic_fingerprint: string | null;
  reference_raw: string | null;
  balance_after: number | null;
}

/**
 * Loads every existing transaction's economic fingerprint for one account,
 * as a `DedupIndex` ready for `dedup.ts`. Cross-import dedup (spec 32, 35)
 * depends on this covering ALL prior transactions for the account, not just
 * the most recent statement — hence the full paginated read rather than a
 * `.limit()`.
 */
export async function loadDedupIndexForAccount(userId: string, financialAccountId: string): Promise<DedupIndex> {
  const supabase = await createClient();
  const rows = await fetchAllRows<FingerprintRow>(() =>
    supabase
      .from('fdh_transactions')
      .select('id, economic_fingerprint, reference_raw, balance_after')
      .eq('user_id', userId)
      .eq('financial_account_id', financialAccountId)
      .not('economic_fingerprint', 'is', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }) as unknown as {
      range: (from: number, to: number) => PromiseLike<{ data: FingerprintRow[] | null; error: { message: string } | null }>;
    },
  );

  const index: DedupIndex = new Map();
  for (const row of rows) {
    if (!row.economic_fingerprint) continue;
    const hasStrongEvidence = Boolean(row.reference_raw) || row.balance_after !== null;
    const entry = { transactionId: row.id, hasStrongEvidence };
    const existing = index.get(row.economic_fingerprint);
    if (existing) existing.push(entry);
    else index.set(row.economic_fingerprint, [entry]);
  }
  return index;
}

export async function loadExistingAccountsForInstitutionCurrency(
  userId: string,
  institutionId: string | null,
  currencyCode: string,
): Promise<ExistingAccountSummary[]> {
  const supabase = await createClient();
  let query = supabase
    .from('fdh_financial_accounts')
    .select('id, account_fingerprint')
    .eq('user_id', userId)
    .eq('currency_code', currencyCode);
  query = institutionId ? query.eq('institution_id', institutionId) : query.is('institution_id', null);
  const { data, error } = await query.order('created_at', { ascending: true }).order('id', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({ id: r.id as string, accountFingerprint: (r.account_fingerprint as string | null) ?? null }));
}

interface DateRangeRow {
  statement_upload_id: string | null;
  transaction_date: string;
}

/** Prior statements' own [min, max] transaction-date ranges for one account,
 * used for date-coverage/overlap reconciliation (spec 44). Excludes the
 * statement currently being processed. */
export async function loadPriorStatementDateRanges(
  userId: string,
  financialAccountId: string,
  excludeStatementUploadId: string,
): Promise<Map<string, DateRange>> {
  const supabase = await createClient();
  const rows = await fetchAllRows<DateRangeRow>(() =>
    supabase
      .from('fdh_transactions')
      .select('statement_upload_id, transaction_date')
      .eq('user_id', userId)
      .eq('financial_account_id', financialAccountId)
      .not('statement_upload_id', 'is', null)
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true }) as unknown as {
      range: (from: number, to: number) => PromiseLike<{ data: DateRangeRow[] | null; error: { message: string } | null }>;
    },
  );

  const ranges = new Map<string, DateRange>();
  for (const row of rows) {
    if (!row.statement_upload_id || row.statement_upload_id === excludeStatementUploadId) continue;
    const existing = ranges.get(row.statement_upload_id);
    if (!existing) {
      ranges.set(row.statement_upload_id, { start: row.transaction_date, end: row.transaction_date });
    } else {
      if (row.transaction_date < existing.start) existing.start = row.transaction_date;
      if (row.transaction_date > existing.end) existing.end = row.transaction_date;
    }
  }
  return ranges;
}
