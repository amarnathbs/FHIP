// Document2 (4) WP-H3 -- production duplicates after a replacement copy was reprocessed: real CAS lines carry NO reference (source_reference is NULL),
// so the unique reference index never applies, and the fingerprint (which includes units, NAV and type) no longer matched rows written by an
// EARLIER parse of the same document. The same real transaction was inserted a second time, with a second source link.
//
// The REAL services (processSourceDocument, replaceSourceDocumentFile) run on the REAL migration chain (PGlite) with REAL PDFs and the real CAMS
// parser. The "earlier parse" is reproduced by ageing already-written rows exactly as the production rows differ from a re-read today: other
// units / NAV (and for one row another type) and a stored fingerprint computed over those old values.
//
// EVIDENCE LABEL: PGLITE-VERIFIED. Not DEV-verified, not production-verified.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { replayAll } from './support/promoTestHelpers';
import { createPgliteSupabase, pgliteOptions, type PgliteSupabase } from './support/pgliteSupabase';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildWphCas, NULL_REF_FOLIO } from '../support/buildWphCasText';

const h = vi.hoisted(() => ({ client: null as unknown as PgliteSupabase, filesByKey: new Map<string, Uint8Array>() }));
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
    return { error: null };
  },
  verifySourceDocumentObjectAbsent: async (key: string) => !h.filesByKey.has(key),
}));
vi.mock('@/lib/aie/malware/config', async (orig) => ({ ...(await orig<typeof import('@/lib/aie/malware/config')>()), isRealMalwareScanEnabled: () => false }));

import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';
import { replaceSourceDocumentFile } from '@/lib/services/investment-intelligence/sourceDocumentReplacement';

const STATEMENT = buildWphCas({ periodStart: '01-Jan-1990', periodEnd: '06-Sep-2026', folios: [NULL_REF_FOLIO] });
// two genuine SIP purchases on 07-Dec-2015 for the same amount (different units: two different instalments; two byte-identical lines would share one fingerprint, a documented pre-existing edge)
const TWO_SAME_DAY = buildWphCas({
  periodStart: '01-Jan-1990',
  periodEnd: '06-Sep-2026',
  folios: [
    {
      ...NULL_REF_FOLIO,
      txns: [
        { date: '07-Dec-2015', amount: '1,000.00', price: '149.6313', units: '6.683', balance: '6.683', type: 'SIP Purchase' },
        { date: '07-Dec-2015', amount: '1,000.00', price: '149.2537', units: '6.700', balance: '13.383', type: 'SIP Purchase' },
      ],
      closingUnits: '13.383',
      closingValue: '2,021.00',
    },
  ],
});

const copy = (label: string, text: string) => ({ bytes: new Uint8Array(buildMinimalTextPdf([text.split('\n'), [`Copy reference ${label}`]])), name: `${label}.pdf` });

let db: PGlite;
let n = 0;
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
interface Fixture {
  userId: string;
  docId: string;
}

async function newUser(label: string): Promise<{ userId: string; memberId: string }> {
  const userId = uid();
  const memberId = uid();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [userId, `${label}-${userId}@example.test`]);
  await db.query(`insert into user_profiles (user_id, country_of_residence, preferred_currency) values ($1, 'IN', 'INR') on conflict (user_id) do update set country_of_residence = 'IN', preferred_currency = 'INR'`, [userId]);
  await db.query(`insert into household_members (id, user_id, full_name, relationship, is_active) values ($1, $2, 'Asha Rao', 'self', true)`, [memberId, userId]);
  return { userId, memberId };
}

async function processedStatement(label: string, text = STATEMENT, userCtx?: { userId: string; memberId: string }): Promise<Fixture> {
  const { userId, memberId } = userCtx ?? (await newUser(label));
  const docId = uid();
  const first = copy(`${label}-original`, text);
  const key = `${userId}/${label}-original.pdf`;
  h.filesByKey.set(key, first.bytes);
  await db.query(
    `insert into ii_source_documents (id, user_id, owner_member_id, country_code, status, storage_path, original_filename, mime_type, file_size, checksum, document_type)
     values ($1, $2, $3, 'IN', 'uploaded', $4, $5, 'application/pdf', $6, $7, 'cas_statement')`,
    [docId, userId, memberId, key, first.name, first.bytes.byteLength, createHash('sha256').update(first.bytes).digest('hex')],
  );
  const r = await processSourceDocument({ userId, sourceDocumentId: docId });
  expect(r.ok, `first processing: ${r.error}`).toBe(true);
  return { userId, docId };
}

interface Row {
  id: string;
  transaction_date: string;
  transaction_type: string;
  units: number | null;
  price_per_unit: number | null;
  gross_amount: number;
  status: string;
  corrects_transaction_id: string | null;
  transaction_fingerprint: string;
  source_reference: string | null;
}
const rowsOf = async (userId: string, docId?: string): Promise<Row[]> =>
  (await db.query<Row>(`select id, to_char(transaction_date, 'YYYY-MM-DD') as transaction_date, transaction_type, units::float8 as units, price_per_unit::float8 as price_per_unit, gross_amount::float8 as gross_amount, status, corrects_transaction_id, transaction_fingerprint, source_reference from ii_transactions where user_id = $1 ${docId ? 'and source_document_id = $2' : ''} order by transaction_date, created_at, id`, docId ? [userId, docId] : [userId])).rows;
const active = (rows: Row[]) => rows.filter((r) => r.status !== 'reversed');
const sum = (rows: Row[], k: 'units' | 'gross_amount') => Math.round(rows.reduce((s, r) => s + Number(r[k] ?? 0), 0) * 1e6) / 1e6;
const links = async (userId: string) => Number((await db.query<{ n: string }>(`select count(*)::text n from ii_transaction_source_links where user_id = $1`, [userId])).rows[0].n);
const casesOf = async (userId: string, type: string) => Number((await db.query<{ n: string }>(`select count(*)::text n from ii_reconciliation_cases where user_id = $1 and discrepancy_type = $2 and status = 'open'`, [userId, type])).rows[0].n);

/** Reproduces how rows written by an EARLIER parse differ from a re-read today: other units / NAV (optionally another type) and a stored fingerprint over the old values. */
async function ageRows(userId: string, dates: string[], opts: { type?: string } = {}): Promise<void> {
  for (const d of dates) {
    await db.query(
      `update ii_transactions set units = units * 10, price_per_unit = price_per_unit / 10, ${opts.type ? `transaction_type = '${opts.type}',` : ''} transaction_fingerprint = 'earlier-parse-' || id where user_id = $1 and transaction_date = $2`,
      [userId, d],
    );
  }
}

async function replaceAndReprocess(f: Fixture, c: { bytes: Uint8Array; name: string }) {
  const rep = await replaceSourceDocumentFile({ userId: f.userId, sourceDocumentId: f.docId, filename: c.name, mimeType: 'application/pdf', bytes: c.bytes });
  if (!rep.ok) return { rep, proc: null };
  const proc = await processSourceDocument({ userId: f.userId, sourceDocumentId: f.docId, forceReparse: true });
  return { rep, proc };
}

beforeAll(async () => {
  db = new PGlite(pgliteOptions);
  await replayAll(db);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  h.client = createPgliteSupabase(db);
}, 900_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(() => h.filesByKey.clear());

const SIP_DATES = ['2015-11-09', '2015-12-07', '2016-01-07', '2016-02-08'];

describe('REAL-SHAPED rows: NULL source_reference, written by an earlier parse of the SAME document', () => {
  it('REGRESSION (fails on the old code with exactly the production symptom): replacement + reprocess must not add a second copy of any line', async () => {
    const f = await processedStatement('regress');
    const before = await rowsOf(f.userId, f.docId);
    expect(before).toHaveLength(5);
    expect(before.every((r) => r.source_reference === null)).toBe(true); // real CAS lines: no reference, the unique index does not apply
    await ageRows(f.userId, [...SIP_DATES, '2014-02-10']);
    const linksBefore = await links(f.userId);
    const unitsBefore = sum(active(await rowsOf(f.userId, f.docId)), 'units');

    const { rep, proc } = await replaceAndReprocess(f, copy('regress-copy', STATEMENT));
    expect(rep.ok, JSON.stringify(rep)).toBe(true);
    expect(proc?.ok, proc?.error ?? '').toBe(true);

    const after = await rowsOf(f.userId, f.docId);
    expect(active(after), 'a second copy of a transaction was inserted next to the first').toHaveLength(5);
    expect(sum(active(after), 'gross_amount')).toBe(14_000);
    // the corrected parse is what counts: the earlier (wrong) figures are out of the ledger, not added to it
    expect(sum(active(after), 'units')).toBeCloseTo(793.514, 3);
    expect(sum(active(after), 'units')).not.toBeCloseTo(unitsBefore + 793.514, 1);
    // lineage: each replaced row is reversed and each new row points at the row it corrects
    const reversed = after.filter((r) => r.status === 'reversed');
    const corrected = after.filter((r) => r.status === 'corrected');
    expect(reversed).toHaveLength(5);
    expect(corrected).toHaveLength(5);
    expect(corrected.map((c) => c.corrects_transaction_id).sort()).toEqual(reversed.map((r) => r.id).sort());
    // one source link per row, not a second link layer for the same real transaction
    expect(await links(f.userId)).toBe(linksBefore + 5);
  }, 300_000);

  it('the second pass (replacement again, and a plain reprocess) adds NOTHING', async () => {
    const f = await processedStatement('second');
    await ageRows(f.userId, SIP_DATES);
    await replaceAndReprocess(f, copy('second-1', STATEMENT));
    const afterFirst = await rowsOf(f.userId, f.docId);
    const linksFirst = await links(f.userId);
    const again = await replaceAndReprocess(f, copy('second-2', STATEMENT));
    expect(again.proc?.ok).toBe(true);
    expect(again.proc?.summary).toMatchObject({ newTransactionsCount: 0 });
    await processSourceDocument({ userId: f.userId, sourceDocumentId: f.docId, forceReparse: false });
    const afterSecond = await rowsOf(f.userId, f.docId);
    expect(afterSecond.map((r) => [r.id, r.status])).toEqual(afterFirst.map((r) => [r.id, r.status]));
    expect(await links(f.userId)).toBe(linksFirst);
  }, 300_000);

  it('an unchanged earlier parse (fingerprints equal) is the plain case: nothing is inserted, nothing is reversed', async () => {
    const f = await processedStatement('plain');
    const before = await rowsOf(f.userId, f.docId);
    const r = await replaceAndReprocess(f, copy('plain-copy', STATEMENT));
    expect(r.proc?.summary).toMatchObject({ newTransactionsCount: 0, duplicateTransactionsLinked: 5 });
    expect((await rowsOf(f.userId, f.docId)).map((x) => [x.id, x.status])).toEqual(before.map((x) => [x.id, x.status]));
  }, 300_000);

  it('same details, different stored fingerprint (for example another source key then): linked, nothing inserted, nothing reversed', async () => {
    const f = await processedStatement('samedetail');
    await db.query(`update ii_transactions set transaction_fingerprint = 'other-source-' || id where user_id = $1`, [f.userId]);
    const before = await rowsOf(f.userId, f.docId);
    const r = await replaceAndReprocess(f, copy('samedetail-copy', STATEMENT));
    expect(r.proc?.ok).toBe(true);
    const after = await rowsOf(f.userId, f.docId);
    expect(after).toHaveLength(5);
    expect(after.map((x) => [x.id, x.status])).toEqual(before.map((x) => [x.id, x.status]));
    // and they are not reported as lines the statement forgot (missing-from-restatement)
    expect(await casesOf(f.userId, 'transaction_missing_from_restatement')).toBe(0);
  }, 300_000);

  it('a row an earlier parse typed differently (the 2009-style pair) is matched by date and amount and replaced, not duplicated', async () => {
    const f = await processedStatement('typed');
    await ageRows(f.userId, ['2014-02-10'], { type: 'adjustment' });
    await replaceAndReprocess(f, copy('typed-copy', STATEMENT));
    const after = active(await rowsOf(f.userId, f.docId));
    expect(after).toHaveLength(5);
    expect(after.find((r) => r.transaction_date === '2014-02-10')).toMatchObject({ transaction_type: 'purchase', status: 'corrected' });
  }, 300_000);

  it('a line with NO twin in the stored rows is genuinely new and is inserted (the only legitimate addition)', async () => {
    const f = await processedStatement('newline');
    await db.query(`delete from ii_transaction_source_links where transaction_id in (select id from ii_transactions where user_id = $1 and transaction_date = '2016-02-08')`, [f.userId]);
    await db.query(`delete from ii_transactions where user_id = $1 and transaction_date = '2016-02-08'`, [f.userId]);
    const r = await replaceAndReprocess(f, copy('newline-copy', STATEMENT));
    expect(r.proc?.summary).toMatchObject({ newTransactionsCount: 1, duplicateTransactionsLinked: 4 });
    const after = active(await rowsOf(f.userId, f.docId));
    expect(after).toHaveLength(5);
    expect(after.find((x) => x.transaction_date === '2016-02-08')).toMatchObject({ status: 'parsed', corrects_transaction_id: null });
  }, 300_000);

  it('two genuine same-day same-amount lines stay TWO (multiset match): 2 stored + 2 re-read = still 2 active; 1 stored + 2 re-read = exactly 1 inserted', async () => {
    const f = await processedStatement('multiset', TWO_SAME_DAY);
    expect(active(await rowsOf(f.userId, f.docId))).toHaveLength(2);
    await ageRows(f.userId, ['2015-12-07']);
    await replaceAndReprocess(f, copy('multiset-copy', TWO_SAME_DAY));
    expect(active(await rowsOf(f.userId, f.docId))).toHaveLength(2);
    expect((await rowsOf(f.userId, f.docId)).filter((r) => r.status === 'reversed')).toHaveLength(2);

    const g = await processedStatement('multiset-one', TWO_SAME_DAY);
    const one = (await rowsOf(g.userId, g.docId))[0];
    await db.query(`delete from ii_transaction_source_links where transaction_id = $1`, [one.id]);
    await db.query(`delete from ii_transactions where id = $1`, [one.id]);
    await ageRows(g.userId, ['2015-12-07']);
    await replaceAndReprocess(g, copy('multiset-one-copy', TWO_SAME_DAY));
    expect(active(await rowsOf(g.userId, g.docId))).toHaveLength(2);
  }, 300_000);

  it("a person's own correction stands: a row the person re-typed is linked, never replaced, and nothing is inserted next to it", async () => {
    const f = await processedStatement('person');
    const target = (await rowsOf(f.userId, f.docId)).find((r) => r.transaction_date === '2014-02-10')!;
    await ageRows(f.userId, ['2014-02-10'], { type: 'redemption' });
    await db.query(`insert into ii_audit_events (user_id, event_type, subject_type, subject_id, actor_type, metadata) values ($1, 'user_correction', 'ii_transactions', $2, 'user', '{}')`, [f.userId, target.id]);
    await replaceAndReprocess(f, copy('person-copy', STATEMENT));
    const after = await rowsOf(f.userId, f.docId);
    const mine = after.filter((r) => r.transaction_date === '2014-02-10');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: target.id, transaction_type: 'redemption', status: 'parsed' });
  }, 300_000);

  it("another document's rows are never matched or touched (the natural key is scoped to the document being re-read)", async () => {
    const f = await processedStatement('scope');
    const other = await processedStatement('scope-other', buildWphCas({ periodStart: '01-Jan-1990', periodEnd: '06-Sep-2026', folios: [NULL_REF_FOLIO] }), { userId: f.userId, memberId: (await db.query<{ owner_member_id: string }>(`select owner_member_id from ii_source_documents where id = $1`, [f.docId])).rows[0].owner_member_id });
    const otherBefore = await rowsOf(f.userId, other.docId);
    await ageRows(f.userId, SIP_DATES);
    await replaceAndReprocess(f, copy('scope-copy', STATEMENT));
    const otherAfter = await rowsOf(f.userId, other.docId);
    expect(otherAfter.map((r) => [r.id, r.status])).toEqual(otherBefore.map((r) => [r.id, r.status]));
  }, 300_000);

  it('positions: the unit reconciliation reads only ACTIVE rows, so no unit_mismatch is raised by the rows that were replaced', async () => {
    const f = await processedStatement('units');
    await ageRows(f.userId, SIP_DATES);
    await replaceAndReprocess(f, copy('units-copy', STATEMENT));
    expect(await casesOf(f.userId, 'unit_mismatch')).toBe(0);
  }, 300_000);
});
