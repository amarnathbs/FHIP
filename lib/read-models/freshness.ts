/**
 * Imported-data freshness for downstream consumers (WP-06, DC-09).
 *
 * The report staleness check and the Data Quality "last updated" column used
 * to look only at the manual registers' updated_at. Approving a bank statement
 * (fdh_transactions), splitting a line (allocations), confirming a link,
 * importing an AU broker statement into Investment Intelligence
 * (ii_holding_snapshots) or publishing it to Net Worth (ii_fhip_publications),
 * or Applying a payslip / statement proposal (fhip_import_applications)
 * therefore never made a stored report stale -- the pre-Apply report kept
 * being served for the rest of the month.
 *
 * The raw table reads live HERE, inside lib/read-models, so that no service
 * or engine outside the read models reads an FDH table directly (DC-19).
 *
 * Failure policy (same as the existing register probe): a table that cannot
 * be read contributes nothing -- it never makes a report look artificially
 * fresh OR artificially stale.
 */
import '@/lib/serverOnly';
import { ECONOMIC_TRANSACTION_TYPES, ECONOMIC_TYPE_BUCKET, type EconomicTransactionType } from './core/spendingRules';
import type { ReadModelClient } from './core/paginate';

export interface InputTimestampSource {
  table: string;
  column: string;
  /** Extra equality filter (e.g. only approved transactions). */
  eq?: [string, unknown];
}

/**
 * Every imported-data table whose change can move a canonical figure, with
 * the timestamp that moves when it does. Rows are written by the FDH
 * pipelines / Investment Intelligence / the import bridge, never edited in
 * place without one of these columns moving -- except deletions (an
 * un-approval clears approved_at; an allocation delete leaves no row), which
 * no timestamp probe can see; the register probe and the report revision
 * mechanism cover those when the user re-applies.
 */
export const IMPORTED_INPUT_TIMESTAMPS: readonly InputTimestampSource[] = [
  { table: 'fdh_transactions', column: 'approved_at', eq: ['approval_status', 'approved'] },
  { table: 'fdh_transaction_allocations', column: 'updated_at' },
  { table: 'fdh_transaction_links', column: 'updated_at' },
  { table: 'ii_holding_snapshots', column: 'created_at' },
  { table: 'ii_fhip_publications', column: 'published_at' },
  { table: 'ii_fhip_publications', column: 'last_republished_at' },
  { table: 'fhip_import_applications', column: 'applied_at' },
];

async function newestOf(client: ReadModelClient, userId: string, src: InputTimestampSource, typeFilter?: readonly string[]): Promise<string | null> {
  try {
    let q = client.from(src.table).select(src.column).eq('user_id', userId);
    if (src.eq) q = q.eq(src.eq[0], src.eq[1]);
    if (typeFilter) q = q.in('economic_transaction_type', [...typeFilter]);
    // NOT NULL filter first: PostgREST orders NULLs FIRST on a descending
    // sort, so without it a single never-approved / never-republished row
    // would hide every real timestamp.
    const r = await q.not(src.column, 'is', null).order(src.column, { ascending: false }).limit(1).maybeSingle();
    if (r.error) return null;
    const v = (r.data as Record<string, unknown> | null)?.[src.column];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function maxTimestamp(values: (string | null)[]): string | null {
  let newest: string | null = null;
  for (const v of values) {
    if (!v) continue;
    // Compare as instants: the columns are timestamptz and may differ in
    // offset formatting between tables.
    if (newest === null || Date.parse(v) > Date.parse(newest)) newest = v;
  }
  return newest;
}

/** The newest change across every imported-data input (null when none). */
export async function loadImportedInputsLastChangedAt(userId: string, client: ReadModelClient): Promise<string | null> {
  const values = await Promise.all(IMPORTED_INPUT_TIMESTAMPS.map((src) => newestOf(client, userId, src)));
  return maxTimestamp(values);
}

export const INCOME_TYPES: readonly EconomicTransactionType[] = ECONOMIC_TRANSACTION_TYPES.filter((t) => ECONOMIC_TYPE_BUCKET[t] === 'income');
export const SPENDING_TYPES: readonly EconomicTransactionType[] = ECONOMIC_TRANSACTION_TYPES.filter((t) => ECONOMIC_TYPE_BUCKET[t] === 'spending');

/**
 * Per Data Quality category: the newest approval of an imported line that the
 * canonical Income / Expense read models count, so a household whose income
 * or expenses come only from approved statements is not reported as
 * "Missing" for a category the report's figures do include.
 */
export async function loadImportedCategoryFreshness(userId: string, client: ReadModelClient): Promise<{ income: string | null; expenses: string | null }> {
  const approved: InputTimestampSource = { table: 'fdh_transactions', column: 'approved_at', eq: ['approval_status', 'approved'] };
  const [income, expenses] = await Promise.all([newestOf(client, userId, approved, INCOME_TYPES), newestOf(client, userId, approved, SPENDING_TYPES)]);
  return { income, expenses };
}

export { maxTimestamp };
