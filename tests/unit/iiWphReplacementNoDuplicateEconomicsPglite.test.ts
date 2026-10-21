// Document2 (4) WP-H (F5/F6/F14) -- "no duplicate economics" proved with a FULL before/after DATABASE ORACLE.
//
// The REAL application code (processSourceDocument, replaceSourceDocumentFile, publishPosition, refreshPosition, the canonical
// Investments read model) runs against the REAL migration chain replayed into PGlite (a real Postgres: unique fingerprints, the
// holding-snapshot unique key, CHECK constraints, triggers and foreign keys all apply), through a supabase-js-shaped client
// (support/pgliteSupabase.ts). The statements are REAL PDF bytes read by the REAL pdf-parse text layer and the REAL CAMS parser; only
// object storage is stubbed (an in-memory map) and the real malware scan is switched off (the documented structural-only mode).
//
// Scenario: old structured statement (processed, file deleted by design, published to FHIP) -> controlled replacement copy ->
// reprocess -> replacement a SECOND time -> reprocess. For each step the oracle counts and sums, for that user, every table that can
// carry economics: transactions (+ source links), holding snapshots, accounts, instruments (+ identifiers), FHIP publications,
// canonical Investments and the Net Worth investments leg. The second pass must change NOTHING economic.
//
// EVIDENCE LABEL: PGLITE-VERIFIED (isolated replay on the migration ledger as of this branch). NOT DEV-verified, NOT production.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { replayAll } from './support/promoTestHelpers';
import { createPgliteSupabase, pgliteOptions, type PgliteSupabase } from './support/pgliteSupabase';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildWphCas, OTHER_FOLIO, PRIME_FOLIO_APR, PRIME_FOLIO_Q1 } from '../support/buildWphCasText';

const h = vi.hoisted(() => ({
  client: null as unknown as PgliteSupabase,
  filesByKey: new Map<string, Uint8Array>(),
  removed: [] as string[],
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.client }));
vi.mock('@/lib/services/investment-intelligence/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/investment-intelligence/storage')>()),
  uploadSourceDocumentObject: async (key: string, bytes: Uint8Array) => {
    h.filesByKey.set(key, bytes);
    return { error: null };
  },
  downloadSourceDocumentObject: async (key: string) => {
    const bytes = h.filesByKey.get(key);
    return bytes ? { bytes, error: null } : { bytes: null, error: 'not found' };
  },
  deleteSourceDocumentObject: async (key: string) => {
    h.filesByKey.delete(key);
    h.removed.push(key);
    return { error: null };
  },
  verifySourceDocumentObjectAbsent: async (key: string) => !h.filesByKey.has(key),
}));
vi.mock('@/lib/aie/malware/config', async (orig) => ({ ...(await orig<typeof import('@/lib/aie/malware/config')>()), isRealMalwareScanEnabled: () => false }));

import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';
import { replaceSourceDocumentFile } from '@/lib/services/investment-intelligence/sourceDocumentReplacement';
import { publishPosition, refreshPosition } from '@/lib/services/investment-intelligence/investmentPublicationService';
import { selectInvestments } from '@/lib/read-models/investments';
import { fxContext } from '@/lib/read-models/core/currency';

const Q1 = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '31-Mar-2025', folios: [PRIME_FOLIO_Q1] });
const APR = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '30-Apr-2025', folios: [PRIME_FOLIO_APR] });
const OTHER = buildWphCas({ periodStart: '01-Apr-2023', periodEnd: '31-Mar-2024', folios: [OTHER_FOLIO] });

/**
 * A distinct REAL PDF per label: the statement text on page 1 and a one-line reference on page 2, so two copies of the same statement
 * have different bytes (a different checksum, as a re-downloaded statement would) but the same statement content.
 */
function copy(label: string, text: string): { bytes: Uint8Array; name: string } {
  const bytes = new Uint8Array(buildMinimalTextPdf([text.split('\n'), [`Copy reference ${label}`]]));
  return { bytes, name: `${label}.pdf` };
}

let db: PGlite;
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

interface Fixture {
  userId: string;
  memberId: string;
  docId: string;
}

async function newUser(label: string): Promise<{ userId: string; memberId: string }> {
  const userId = uid();
  const memberId = uid();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, `${label}-${userId}@example.test`]);
  await db.query(
    `insert into user_profiles (user_id, country_of_residence, preferred_currency) values ($1, 'IN', 'INR')
     on conflict (user_id) do update set country_of_residence = 'IN', preferred_currency = 'INR'`,
    [userId],
  );
  await db.query(`insert into household_members (id, user_id, full_name, relationship, is_active) values ($1, $2, 'Asha Rao', 'self', true)`, [memberId, userId]);
  return { userId, memberId };
}

/** A statement uploaded for Asha, processed from the Q1 text, then (as in production) its raw file deleted. */
async function processedStatement(label: string): Promise<Fixture> {
  const { userId, memberId } = await newUser(label);
  const docId = uid();
  const first = copy(`${label}-original`, Q1);
  const key = `${userId}/${label}-original.pdf`;
  h.filesByKey.set(key, first.bytes);
  await db.query(
    `insert into ii_source_documents (id, user_id, owner_member_id, country_code, status, storage_path, original_filename, mime_type, file_size, checksum, document_type)
     values ($1, $2, $3, 'IN', 'uploaded', $4, $5, 'application/pdf', $6, $7, 'cas_statement')`,
    [docId, userId, memberId, key, first.name, first.bytes.byteLength, createHash('sha256').update(first.bytes).digest('hex')],
  );
  const r = await processSourceDocument({ userId, sourceDocumentId: docId });
  expect(r.ok, `first processing: ${r.error}`).toBe(true);
  const doc = (await db.query<{ storage_purged_at: string | null }>(`select storage_purged_at from ii_source_documents where id = $1`, [docId])).rows[0];
  expect(doc.storage_purged_at, 'the raw file is deleted right after a successful parse (by design)').not.toBeNull();
  return { userId, memberId, docId };
}

async function publishAll(userId: string): Promise<void> {
  const snaps = (await db.query<{ id: string }>(`select id from ii_holding_snapshots where user_id = $1 order by as_of_date desc, id`, [userId])).rows;
  for (const s of snaps.slice(0, 1)) {
    const r = await publishPosition(userId, s.id);
    expect(r.error, `publish: ${r.error}`).toBeNull();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------------------------------
interface Oracle {
  economic: {
    accounts: number;
    instruments: number;
    instrumentIdentifiers: number;
    transactions: number;
    transactionAmountSum: number;
    transactionUnitsSum: number;
    transactionSourceLinks: number;
    holdingSnapshots: number;
    holdingUnitsSum: number;
    holdingValueSum: number;
    publicationsPublished: number;
    publicationsAll: number;
    investmentsActive: number;
    investmentsActiveValueSum: number;
    investmentsIiPublishedActive: number;
    netWorthInvestmentsPublishedTotal: number;
    netWorthInvestmentsLineCount: number;
    unpublishedBucketCount: number;
    portfolioTruthRows: number;
  };
  /** Bookkeeping that legitimately grows (one run and some audit rows per processing) -- never economics. */
  bookkeeping: { parseRuns: number; auditEvents: number; reconciliationCases: number; openBlockingCases: number };
}

async function oracle(userId: string): Promise<Oracle> {
  const num = async (sql: string) => Number((await db.query<{ v: string | null }>(sql, sql.includes('$1') ? [userId] : [])).rows[0].v ?? 0);
  const inv = await selectInvestments(userId, { client: h.client as never, fx: fxContext('INR', 56, 'IN') });
  if (inv.status !== 'ok') throw new Error(`net worth investments leg unavailable: ${JSON.stringify(inv)}`);
  return {
    economic: {
      accounts: await num(`select count(*)::text v from ii_accounts where user_id = $1`),
      // instruments are not user-scoped: count the ones this user's rows point at, by name, so a duplicate provisional instrument shows
      instruments: await num(`select count(*)::text v from ii_instruments where instrument_name like 'Prime Flexi%' or instrument_name like 'Zenith%'`),
      instrumentIdentifiers: await num(`select count(*)::text v from ii_instrument_identifiers where identifier_value in ('INF999K01AB1', 'INF888K01ZZ9')`),
      transactions: await num(`select count(*)::text v from ii_transactions where user_id = $1`),
      transactionAmountSum: await num(`select coalesce(sum(gross_amount), 0)::text v from ii_transactions where user_id = $1`),
      transactionUnitsSum: await num(`select coalesce(sum(units), 0)::text v from ii_transactions where user_id = $1`),
      transactionSourceLinks: await num(`select count(*)::text v from ii_transaction_source_links where user_id = $1`),
      holdingSnapshots: await num(`select count(*)::text v from ii_holding_snapshots where user_id = $1`),
      holdingUnitsSum: await num(`select coalesce(sum(units), 0)::text v from ii_holding_snapshots where user_id = $1`),
      holdingValueSum: await num(`select coalesce(sum(value), 0)::text v from ii_holding_snapshots where user_id = $1`),
      publicationsPublished: await num(`select count(*)::text v from ii_fhip_publications where user_id = $1 and status = 'published'`),
      publicationsAll: await num(`select count(*)::text v from ii_fhip_publications where user_id = $1`),
      investmentsActive: await num(`select count(*)::text v from investments where user_id = $1 and is_active`),
      investmentsActiveValueSum: await num(`select coalesce(sum(current_value), 0)::text v from investments where user_id = $1 and is_active`),
      investmentsIiPublishedActive: await num(`select count(*)::text v from investments where user_id = $1 and is_active and source_type = 'investment_intelligence_published'`),
      netWorthInvestmentsPublishedTotal: inv.publishedTotal,
      netWorthInvestmentsLineCount: inv.lines.length,
      unpublishedBucketCount: inv.unpublished.count,
      portfolioTruthRows: await num(`select count(*)::text v from ii_portfolio_truth_status where user_id = $1`),
    },
    bookkeeping: {
      parseRuns: await num(`select count(*)::text v from ii_document_parse_runs where user_id = $1`),
      auditEvents: await num(`select count(*)::text v from ii_audit_events where user_id = $1`),
      reconciliationCases: await num(`select count(*)::text v from ii_reconciliation_cases where user_id = $1`),
      openBlockingCases: await num(`select count(*)::text v from ii_reconciliation_cases where user_id = $1 and status = 'open' and severity = 'blocking'`),
    },
  };
}

/** Names every economic field that differs, so a failure says WHICH table duplicated. */
function economicDiff(before: Oracle, after: Oracle): Record<string, { before: number; after: number }> {
  const out: Record<string, { before: number; after: number }> = {};
  for (const k of Object.keys(before.economic) as (keyof Oracle['economic'])[]) {
    if (before.economic[k] !== after.economic[k]) out[k] = { before: before.economic[k], after: after.economic[k] };
  }
  return out;
}

async function replaceAndReprocess(f: Fixture, c: { bytes: Uint8Array; name: string }, confirm: string[] = []) {
  const rep = await replaceSourceDocumentFile({ userId: f.userId, sourceDocumentId: f.docId, filename: c.name, mimeType: 'application/pdf', bytes: c.bytes, confirmedDifferences: confirm });
  if (!rep.ok) return { rep, proc: null };
  const proc = await processSourceDocument({ userId: f.userId, sourceDocumentId: f.docId, forceReparse: true });
  return { rep, proc };
}

beforeEach(() => {
  h.filesByKey.clear(); // each test starts with an empty object store, so "nothing was stored" assertions mean this test
  h.removed.length = 0;
});

beforeAll(async () => {
  db = new PGlite(pgliteOptions);
  await replayAll(db);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  h.client = createPgliteSupabase(db);
}, 900_000);

afterAll(async () => {
  await db?.close();
});

describe('the oracle itself is real (it sees the economics it claims to)', () => {
  it('a processed and published statement shows 1 account, 1 instrument, 2 transactions, 1 holding, 1 publication, 1 canonical investment worth 7,800.00 counted once in Net Worth', async () => {
    const f = await processedStatement('oracle-shape');
    await publishAll(f.userId);
    const o = await oracle(f.userId);
    expect(o.economic).toMatchObject({
      accounts: expect.any(Number),
      transactions: 2,
      transactionAmountSum: 7500,
      transactionUnitsSum: 150,
      holdingSnapshots: 1,
      holdingUnitsSum: 150,
      holdingValueSum: 7800,
      publicationsPublished: 1,
      investmentsActive: 1,
      investmentsIiPublishedActive: 1,
    });
    expect(o.economic.accounts).toBe(1);
    expect(o.economic.netWorthInvestmentsLineCount).toBe(1);
    expect(o.economic.netWorthInvestmentsPublishedTotal).toBe(7800);
    expect(o.economic.unpublishedBucketCount).toBe(0);
  }, 120_000);
});

describe('old structured statement -> replacement copy -> reprocess: nothing economic changes, and the second pass changes nothing at all', () => {
  it('an identical statement re-downloaded (different bytes) is recognised as the same statement, attached to the SAME row and reprocessed with zero economic change; the second replacement is a no-op too', async () => {
    const f = await processedStatement('same');
    await publishAll(f.userId);
    const o0 = await oracle(f.userId);

    const one = await replaceAndReprocess(f, copy('same-redownload-1', Q1));
    expect(one.rep.ok, JSON.stringify(one.rep)).toBe(true);
    expect(one.rep.ok && one.rep.identity.decision).toBe('match');
    expect(one.proc?.ok, one.proc?.error ?? '').toBe(true);
    expect(one.proc?.summary).toMatchObject({ transactionsFound: 2, newTransactionsCount: 0, duplicateTransactionsLinked: 2, holdingsFound: 1 });
    const o1 = await oracle(f.userId);
    expect(economicDiff(o0, o1), 'first replacement changed economics').toEqual({});

    // second pass: a DIFFERENT file with the same content, and then the very same bytes again
    const two = await replaceAndReprocess(f, copy('same-redownload-2', Q1));
    expect(two.rep.ok && two.proc?.ok).toBe(true);
    const o2 = await oracle(f.userId);
    expect(economicDiff(o1, o2), 'second pass changed economics').toEqual({});
    const sameBytes = copy('same-redownload-2', Q1); // identical bytes to the file just processed
    const three = await replaceAndReprocess(f, sameBytes);
    expect(three.rep.ok && three.proc?.ok).toBe(true);
    const o3 = await oracle(f.userId);
    expect(economicDiff(o2, o3), 'third pass (same bytes) changed economics').toEqual({});
    expect(economicDiff(o0, o3), 'after three replacements the economics differ from the start').toEqual({});

    // Net Worth: the investment is counted once at the statement value, from the one canonical Investments row
    expect(o3.economic).toMatchObject({ transactions: 2, holdingSnapshots: 1, publicationsAll: 1, investmentsActive: 1, netWorthInvestmentsPublishedTotal: 7800, netWorthInvestmentsLineCount: 1, unpublishedBucketCount: 0, accounts: 1, instruments: 1 });

    // the same logical document: one row, same id and owner; every run is bookkeeping, never a second statement
    const docs = (await db.query<{ id: string; owner_member_id: string }>(`select id, owner_member_id from ii_source_documents where user_id = $1`, [f.userId])).rows;
    expect(docs).toEqual([{ id: f.docId, owner_member_id: f.memberId }]);
    expect(o3.bookkeeping.parseRuns).toBe(o0.bookkeeping.parseRuns + 3);
    // nothing new blocks: the replaced statement does not open a blocking case the original did not have
    expect(o3.bookkeeping.openBlockingCases).toBe(o0.bookkeeping.openBlockingCases);
  }, 300_000);

  it('a corrected / extended copy (one more purchase, closing a month later) needs confirmation; unconfirmed it changes nothing; confirmed, the ONLY economic differences are the new purchase and the new holding date; Net Worth counts the fund once; the second pass changes nothing', async () => {
    const f = await processedStatement('extend');
    await publishAll(f.userId);
    const o0 = await oracle(f.userId);
    const docBefore = (await db.query(`select * from ii_source_documents where id = $1`, [f.docId])).rows[0];

    const april = copy('extend-april', APR);
    // 1. without confirmation: refused, and the database is exactly as it was
    const refused = await replaceSourceDocumentFile({ userId: f.userId, sourceDocumentId: f.docId, filename: april.name, mimeType: 'application/pdf', bytes: april.bytes });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.code).toBe('replacement_needs_confirmation');
    expect(!refused.ok && refused.message).toMatch(/01-01-2025 to 30-04-2025/); // day-first, India style
    expect(!refused.ok && refused.message).toMatch(/01-01-2025 to 31-03-2025/);
    expect(!refused.ok && refused.message).not.toMatch(/2025-0\d-\d\d/); // never ISO
    expect(h.filesByKey.size, 'nothing was stored for a copy that was not confirmed').toBe(0);
    expect((await db.query(`select * from ii_source_documents where id = $1`, [f.docId])).rows[0]).toEqual(docBefore);
    expect(economicDiff(o0, await oracle(f.userId))).toEqual({});

    // 2. confirmed: attached and reprocessed
    const done = await replaceAndReprocess(f, april, ['period_differs']);
    expect(done.rep.ok, JSON.stringify(done.rep)).toBe(true);
    expect(done.proc?.ok, done.proc?.error ?? '').toBe(true);
    expect(done.proc?.summary).toMatchObject({ transactionsFound: 3, newTransactionsCount: 1, duplicateTransactionsLinked: 2 });
    const o1 = await oracle(f.userId);
    expect(economicDiff(o0, o1)).toEqual({
      transactions: { before: 2, after: 3 },
      transactionAmountSum: { before: 7500, after: 10150 },
      transactionUnitsSum: { before: 150, after: 200 },
      transactionSourceLinks: { before: 2, after: 3 },
      holdingSnapshots: { before: 1, after: 2 },
      holdingUnitsSum: { before: 150, after: 350 }, // two dated snapshots (150 at 31-03-2025, 200 at 30-04-2025), one per date
      holdingValueSum: { before: 7800, after: 18400 },
    });
    // no new account, instrument or identifier: the Prime fund is the SAME fund
    expect(o1.economic.accounts).toBe(1);
    expect(o1.economic.instruments).toBe(1);
    expect(o1.economic.instrumentIdentifiers).toBe(o0.economic.instrumentIdentifiers);

    // 3. publish the newer holding: the canonical Investments row is UPDATED in place, never added to
    const newest = (await db.query<{ id: string }>(`select id from ii_holding_snapshots where user_id = $1 order by as_of_date desc limit 1`, [f.userId])).rows[0].id;
    const refreshed = await refreshPosition(f.userId, newest);
    expect(refreshed.error, `refresh: ${refreshed.error}`).toBeNull();
    const o2 = await oracle(f.userId);
    expect(o2.economic.investmentsActive, 'one canonical investment, not two').toBe(1);
    expect(o2.economic.netWorthInvestmentsLineCount).toBe(1);
    expect(o2.economic.netWorthInvestmentsPublishedTotal, 'Net Worth counts the fund once at the newest statement value').toBe(10600);
    expect(o2.economic.unpublishedBucketCount).toBe(0);

    // 4. second pass with the same extended copy (again confirmed): zero change of any economic field
    const again = await replaceAndReprocess(f, copy('extend-april-2', APR), ['period_differs']);
    expect(again.rep.ok && again.proc?.ok, JSON.stringify(again.rep)).toBe(true);
    expect(again.proc?.summary).toMatchObject({ newTransactionsCount: 0, duplicateTransactionsLinked: 3 });
    const o3 = await oracle(f.userId);
    expect(economicDiff(o2, o3), 'second pass changed economics').toEqual({});
  }, 300_000);

  it('DOCUMENTED LIMIT: a replacement that CORRECTS a figure for an as-of date already recorded does not overwrite it (the first holding snapshot for an account, fund and date wins); nothing is duplicated', async () => {
    const f = await processedStatement('corrected');
    const o0 = await oracle(f.userId);
    const corrected = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '31-Mar-2025', folios: [{ ...PRIME_FOLIO_Q1, closingValue: '7,950.00', closingNav: '53.00' }] });
    const r = await replaceAndReprocess(f, copy('corrected-copy', corrected));
    expect(r.rep.ok && r.proc?.ok, JSON.stringify(r.rep)).toBe(true);
    const o1 = await oracle(f.userId);
    expect(economicDiff(o0, o1)).toEqual({});
    expect(o1.economic.holdingValueSum, 'the recorded value for that date is kept').toBe(7800);
  }, 300_000);
});

describe('an unrelated statement never replaces anything (and leaves no trace in the economics)', () => {
  it('a different folio, fund house and financial year is refused before the file reference is switched: the row, the storage and every economic table are untouched', async () => {
    const f = await processedStatement('unrelated');
    await publishAll(f.userId);
    const o0 = await oracle(f.userId);
    const docBefore = (await db.query(`select * from ii_source_documents where id = $1`, [f.docId])).rows[0];
    const other = copy('unrelated-other', OTHER);
    const r = await replaceSourceDocumentFile({ userId: f.userId, sourceDocumentId: f.docId, filename: other.name, mimeType: 'application/pdf', bytes: other.bytes });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('replacement_identity_conflict');
    expect(!r.ok && r.identity?.differences.map((d) => d.code).sort()).toEqual(['no_common_folio', 'period_no_overlap', 'schemes_differ']);
    expect(!r.ok && r.message).toMatch(/01-04-2023 to 31-03-2024/);
    expect(!r.ok && r.message).toMatch(/Nothing was changed/);
    expect(h.filesByKey.size).toBe(0);
    expect((await db.query(`select * from ii_source_documents where id = $1`, [f.docId])).rows[0]).toEqual(docBefore);
    // even if someone then asks to process it, there is no file: the statement cannot be silently re-read as something else
    const p = await processSourceDocument({ userId: f.userId, sourceDocumentId: f.docId, forceReparse: true });
    expect(p.status).toBe('source_file_not_stored');
    expect(economicDiff(o0, await oracle(f.userId))).toEqual({});
    expect((await db.query(`select count(*)::int n from ii_instruments where instrument_name like 'Zenith%'`)).rows[0]).toEqual({ n: 0 });
  }, 300_000);

  it('TWO-USER CROSS-TENANT: another user cannot replace (or probe) this statement: 404, no file stored, no change for either user', async () => {
    const a = await processedStatement('tenant-a');
    await publishAll(a.userId);
    const b = await newUser('tenant-b');
    const oa = await oracle(a.userId);
    const ob = await oracle(b.userId);
    const docBefore = (await db.query(`select * from ii_source_documents where id = $1`, [a.docId])).rows[0];
    const r = await replaceSourceDocumentFile({ userId: b.userId, sourceDocumentId: a.docId, filename: 'x.pdf', mimeType: 'application/pdf', bytes: copy('tenant-attack', Q1).bytes });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.httpStatus).toBe(404);
    expect(!r.ok && r.code).toBe('not_found');
    expect(h.filesByKey.size).toBe(0);
    expect((await db.query(`select * from ii_source_documents where id = $1`, [a.docId])).rows[0]).toEqual(docBefore);
    expect(await oracle(a.userId)).toEqual(oa);
    expect(await oracle(b.userId)).toEqual(ob);
  }, 300_000);
});

describe('NEGATIVE CONTROLS: the oracle fails when economics DO duplicate', () => {
  it('if the folio no longer matches the existing account (here: the account was closed), the very same replacement DOES duplicate accounts, transactions and holdings, the oracle names them, and the "second pass changed nothing" assertion goes red', async () => {
    const f = await processedStatement('control-dup');
    await publishAll(f.userId);
    const o0 = await oracle(f.userId);
    await db.query(`update ii_accounts set status = 'closed' where user_id = $1`, [f.userId]); // account identity can no longer be matched
    const r = await replaceAndReprocess(f, copy('control-dup-copy', Q1));
    expect(r.rep.ok && r.proc?.ok).toBe(true);
    const o1 = await oracle(f.userId);
    const diff = economicDiff(o0, o1);
    expect(Object.keys(diff)).toEqual(expect.arrayContaining(['accounts', 'transactions', 'holdingSnapshots', 'transactionAmountSum']));
    expect(diff.transactions).toEqual({ before: 2, after: 4 });
    await expectRed(() => expect(economicDiff(o0, o1), 'second pass changed economics').toEqual({}), 'second pass changed economics');
  }, 300_000);
});

/** The control must fail with a real AssertionError that carries the named message, or the guard it stands for is not guarding anything. */
async function expectRed(assertion: () => unknown, named: string): Promise<void> {
  let failure: Error | null = null;
  try {
    await assertion();
  } catch (e) {
    failure = e as Error;
  }
  if (!failure) throw new Error(`the assertion did NOT fail against the deliberately broken state (${named}): the test cannot detect this regression`);
  expect(failure.name).toBe('AssertionError');
  expect(failure.message).toContain(named);
}
