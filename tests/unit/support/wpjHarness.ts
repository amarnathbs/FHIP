/**
 * Document2 (4) WP-J -- shared helpers for the statement-job tests on a REAL Postgres (PGlite, this repository's whole migration chain):
 * synthetic users, large synthetic CAMS statements as real PDFs, the economic ORACLE, and a driver that advances a job slice by slice.
 *
 * The caller's test file owns the vi.mock calls (they must be hoisted there); this module only needs the database and the in-memory
 * object store the mocks read from.
 */
import type { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { buildMinimalTextPdf } from '../../support/buildMinimalPdf';
import { paginateLines } from '../../support/buildWpjLargeCas';
import { selectInvestments } from '@/lib/read-models/investments';
import { fxContext } from '@/lib/read-models/core/currency';

export interface Harness {
  db: PGlite;
  /** The service-role shaped client the mocks hand to the application code. */
  client: unknown;
  /** The in-memory object store the storage mock reads. */
  files: Map<string, Uint8Array>;
}

let n = 0;
export const uid = () => `00000000-0000-4000-8000-${String(++n + 400000).padStart(12, '0')}`;

export async function newUser(db: PGlite, label: string, opts: { withSelfMember?: boolean } = {}): Promise<{ userId: string; memberId: string }> {
  const userId = uid();
  const memberId = uid();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, `${label}-${userId}@example.test`]);
  await db.query(
    `insert into user_profiles (user_id, country_of_residence, preferred_currency) values ($1, 'IN', 'INR')
     on conflict (user_id) do update set country_of_residence = 'IN', preferred_currency = 'INR'`,
    [userId],
  );
  if (opts.withSelfMember !== false) {
    await db.query(`insert into household_members (id, user_id, full_name, relationship, is_active) values ($1, $2, 'Asha Rao', 'self', true)`, [memberId, userId]);
  }
  return { userId, memberId };
}

/** A real PDF of the statement lines (one page per ~58 lines, then a one-line reference page so two copies have different bytes). */
export function statementPdf(lines: string[], label: string): Uint8Array {
  return new Uint8Array(buildMinimalTextPdf([...paginateLines(lines), [`Copy reference ${label}`]]));
}

/** Uploads a statement document for a user with the owner chosen up front (the normal path) and returns its id. */
export async function seedStatement(h: Harness, user: { userId: string; memberId: string }, bytes: Uint8Array, label: string, opts: { owner?: boolean } = {}): Promise<string> {
  const docId = uid();
  const key = `${user.userId}/${label}-${docId}.pdf`;
  h.files.set(key, bytes);
  await h.db.query(
    `insert into ii_source_documents (id, user_id, owner_member_id, country_code, status, storage_path, original_filename, mime_type, file_size, checksum, document_type)
     values ($1, $2, $3, 'IN', 'uploaded', $4, $5, 'application/pdf', $6, $7, 'cas_statement')`,
    [docId, user.userId, opts.owner === false ? null : user.memberId, key, `${label}.pdf`, bytes.byteLength, createHash('sha256').update(bytes).digest('hex')],
  );
  return docId;
}

/** Attaches a (new) copy of the file to an existing statement, as a replacement copy does: same row, new object, not purged. */
export async function attachCopy(h: Harness, userId: string, docId: string, bytes: Uint8Array, label: string): Promise<void> {
  const key = `${userId}/${label}-${docId}.pdf`;
  h.files.set(key, bytes);
  await h.db.query(`update ii_source_documents set storage_path = $2, storage_purged_at = null, checksum = $3, file_size = $4 where id = $1`, [docId, key, createHash('sha256').update(bytes).digest('hex'), bytes.byteLength]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------------------------------
export interface Oracle {
  economic: {
    accounts: number;
    instrumentsReferenced: number;
    transactionsActive: number;
    transactionsReversed: number;
    transactionsCorrected: number;
    transactionAmountSumActive: number;
    transactionUnitsSumActive: number;
    transactionSourceLinks: number;
    transactionOriginatingLinks: number;
    holdingSnapshots: number;
    holdingUnitsSum: number;
    holdingValueSum: number;
    publicationsPublished: number;
    publicationsAll: number;
    investmentsActive: number;
    investmentsActiveValueSum: number;
    netWorthInvestmentsPublishedTotal: number;
    netWorthInvestmentsLineCount: number;
    unpublishedBucketCount: number;
    portfolioTruthRows: number;
    portfolioTruthCertified: number;
  };
  /** Bookkeeping that legitimately grows (a run and some audit rows per processing). Never economics. */
  bookkeeping: { parseRuns: number; parseRunsRunning: number; reconciliationCasesOpen: number };
}

export async function oracle(h: Harness, userId: string): Promise<Oracle> {
  const num = async (sql: string) => Number((await h.db.query<{ v: string | null }>(sql, [userId])).rows[0].v ?? 0);
  const inv = await selectInvestments(userId, { client: h.client as never, fx: fxContext('INR', 56, 'IN') });
  if (inv.status !== 'ok') throw new Error(`net worth investments leg unavailable: ${JSON.stringify(inv)}`);
  return {
    economic: {
      accounts: await num(`select count(*)::text v from ii_accounts where user_id = $1`),
      instrumentsReferenced: await num(`select count(distinct instrument_id)::text v from ii_transactions where user_id = $1`),
      transactionsActive: await num(`select count(*)::text v from ii_transactions where user_id = $1 and status <> 'reversed'`),
      transactionsReversed: await num(`select count(*)::text v from ii_transactions where user_id = $1 and status = 'reversed'`),
      transactionsCorrected: await num(`select count(*)::text v from ii_transactions where user_id = $1 and status = 'corrected'`),
      transactionAmountSumActive: await num(`select coalesce(sum(gross_amount), 0)::text v from ii_transactions where user_id = $1 and status <> 'reversed'`),
      transactionUnitsSumActive: await num(`select coalesce(sum(units), 0)::text v from ii_transactions where user_id = $1 and status <> 'reversed'`),
      transactionSourceLinks: await num(`select count(*)::text v from ii_transaction_source_links where user_id = $1`),
      transactionOriginatingLinks: await num(`select count(*)::text v from ii_transaction_source_links where user_id = $1 and is_originating`),
      holdingSnapshots: await num(`select count(*)::text v from ii_holding_snapshots where user_id = $1`),
      holdingUnitsSum: await num(`select coalesce(sum(units), 0)::text v from ii_holding_snapshots where user_id = $1`),
      holdingValueSum: await num(`select coalesce(sum(value), 0)::text v from ii_holding_snapshots where user_id = $1`),
      publicationsPublished: await num(`select count(*)::text v from ii_fhip_publications where user_id = $1 and status = 'published'`),
      publicationsAll: await num(`select count(*)::text v from ii_fhip_publications where user_id = $1`),
      investmentsActive: await num(`select count(*)::text v from investments where user_id = $1 and is_active`),
      investmentsActiveValueSum: await num(`select coalesce(sum(current_value), 0)::text v from investments where user_id = $1 and is_active`),
      netWorthInvestmentsPublishedTotal: inv.publishedTotal,
      netWorthInvestmentsLineCount: inv.lines.length,
      unpublishedBucketCount: inv.unpublished.count,
      portfolioTruthRows: await num(`select count(*)::text v from ii_portfolio_truth_status where user_id = $1`),
      portfolioTruthCertified: await num(`select count(*)::text v from ii_portfolio_truth_status where user_id = $1 and status in ('certified', 'certified_with_warnings')`),
    },
    bookkeeping: {
      parseRuns: await num(`select count(*)::text v from ii_document_parse_runs where user_id = $1`),
      parseRunsRunning: await num(`select count(*)::text v from ii_document_parse_runs where user_id = $1 and run_status = 'running'`),
      reconciliationCasesOpen: await num(`select count(*)::text v from ii_reconciliation_cases where user_id = $1 and status = 'open'`),
    },
  };
}

/** Names every economic field that differs, so a failure says WHICH table duplicated. */
export function economicDiff(before: Oracle, after: Oracle): Record<string, { before: number; after: number }> {
  const out: Record<string, { before: number; after: number }> = {};
  for (const k of Object.keys(before.economic) as (keyof Oracle['economic'])[]) {
    if (Math.abs(before.economic[k] - after.economic[k]) > 1e-6) out[k] = { before: before.economic[k], after: after.economic[k] };
  }
  return out;
}

/** The oracle of the job tables for one user (staging must be empty once a job ends). */
export async function stagingRows(h: Harness, userId: string): Promise<number> {
  return Number((await h.db.query<{ v: string }>(`select count(*)::text v from ii_statement_job_chunks where user_id = $1`, [userId])).rows[0].v);
}

/** Makes a held lease run out NOW (a slice that died holds its lease until the database clock passes it). */
export async function expireLease(h: Harness, jobId: string): Promise<void> {
  await h.db.query(`update ii_statement_jobs set lease_expires_at = now() - interval '1 second' where id = $1`, [jobId]);
}
