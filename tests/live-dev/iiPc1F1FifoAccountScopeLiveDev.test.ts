// II-PC1-F1 — R6 FIFO ACCOUNT-SCOPE, LIVE HOSTED-DEV CERTIFICATION.
//
// WHAT MAKES THIS FIXTURE DIFFERENT FROM II-PC1's
// -----------------------------------------------
// II-PC1's closure fixture used Folio A / AMC Alpha and Folio B / AMC Beta —
// two DIFFERENT schemes, therefore two different instrument_ids. Under that
// shape, account-scoped and instrument-scoped FIFO coincide exactly, which is
// why PC1 could disclose the architectural question but could not answer it.
//
// This fixture uses the SAME AMC, the SAME scheme name, the SAME ISIN and the
// SAME AMFI code across TWO folios — so both folios resolve to ONE canonical
// instrument_id held under TWO canonical ii_accounts rows. That is the only
// shape in which the two models disagree, and it is a shape a real CAMS
// Consolidated Account Statement genuinely produces.
//
// DECIDED RULE: ACCOUNT_SCOPED_FIFO. See
// docs/investment-intelligence/II_PC1_F1_FIFO_SCOPE_DECISION.md.
//
// METHODOLOGY — identical, disclosed substitutions to
// tests/live-dev/iiPc1ClosureVerification.test.ts:
//   * pdf-parse mocked at the module boundary only (absent from node_modules,
//     pre-existing and unrelated); every statement is uploaded as text/csv so
//     the PDF-extraction branch is never reached.
//   * Real DEV Supabase, real synthetic auth users with real JWTs, real
//     storage objects, real processSourceDocument parsing/account resolution.
//     Service functions are called directly rather than through a live
//     Next.js HTTP server — the same methodology, and the same honest
//     distinction, that R11/PC1's live-DEV suites document.
//   * Tax lots are NEVER direct-inserted (dispatch §25): every lot and
//     consumption in this suite comes from the real R6 calculation path.

import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js';

vi.mock('pdf-parse', () => ({
  PDFParse: class {},
  PasswordException: class extends Error {},
}));

// ---------------------------------------------------------------------------
// Environment + hard DEV guard
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(__dirname, '..', '..');
const envFile = path.join(repoRoot, '.env.local');
const env: Record<string, string> = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
const actualRef = new URL(BASE).host.split('.')[0];
if (actualRef !== EXPECTED_DEV_REF) {
  throw new Error(`REFUSING TO RUN: target project "${actualRef}" is not the expected DEV project. This suite never touches production.`);
}

process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;

const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const STAMP = Date.now();
const RUN_TAG = `f1-${STAMP}`;
const cleanupUserIds: string[] = [];

interface SyntheticUser {
  userId: string;
  email: string;
  password: string;
  client: SupabaseClient;
  memberId: string | null;
}

async function makeUser(tag: string, opts: { withHousehold?: boolean } = {}): Promise<SyntheticUser> {
  const email = `${RUN_TAG}-${tag}@fhip-synthetic.test`;
  const password = `Synthetic!${RUN_TAG}-${tag}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create synthetic user ${tag}: ${error?.message}`);
  cleanupUserIds.push(data.user.id);

  const signIn = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = (await signIn.json()) as { access_token?: string };
  if (!session.access_token) throw new Error(`could not sign in synthetic user ${tag}`);
  const client = createSupabaseJsClient(BASE, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });

  let memberId: string | null = null;
  if (opts.withHousehold) {
    const { data: hh, error: hhErr } = await admin.from('households').insert({ user_id: data.user.id, household_name: `F1 ${tag}`, primary_country: 'IN' }).select('id').single();
    if (hhErr || !hh) throw new Error(`household insert failed for ${tag}: ${hhErr?.message}`);
    const { data: mem, error: memErr } = await admin
      .from('household_members')
      .insert({ user_id: data.user.id, household_id: hh.id, full_name: `F1 Test Self ${tag}`, relationship: 'self' })
      .select('id')
      .single();
    if (memErr || !mem) throw new Error(`household_member insert failed for ${tag}: ${memErr?.message}`);
    memberId = mem.id as string;
  }
  return { userId: data.user.id, email, password, client, memberId };
}

async function uploadTextStatement(userId: string, ownerMemberId: string | null, filename: string, text: string): Promise<string> {
  const { II_STORAGE_BUCKET } = await import('@/lib/services/investment-intelligence/storage');
  const bytes = Buffer.from(text, 'utf8');
  const objectKey = `${userId}/${randomUUID()}.csv`;
  const { error: upErr } = await admin.storage.from(II_STORAGE_BUCKET).upload(objectKey, bytes, { contentType: 'text/csv', upsert: false });
  if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const { data: doc, error: docErr } = await admin
    .from('ii_source_documents')
    .insert({
      user_id: userId,
      owner_member_id: ownerMemberId,
      country_code: 'IN',
      status: 'uploaded',
      checksum,
      storage_path: objectKey,
      original_filename: filename,
      mime_type: 'text/csv',
      file_size: bytes.length,
      document_type: 'cas_statement',
    })
    .select('id')
    .single();
  if (docErr || !doc) throw new Error(`ii_source_documents insert failed: ${docErr?.message}`);
  return doc.id as string;
}

interface TxnRow { date: string; desc: string; amount: string; units: string; nav: string; balance: string; ref: string }

function camsLines(opts: { folio: string; pan: string; name: string; amc: string; scheme: string; isin: string; amfi: string; rows: TxnRow[]; closing: { date: string; units: string; value: string; nav: string } }): string[] {
  const lines = [
    `Folio No: ${opts.folio}`,
    `PAN: ${opts.pan}`,
    `Name: ${opts.name}`,
    'Holding Mode: SI',
    '',
    `AMC Name: ${opts.amc}`,
    `Scheme Name: ${opts.scheme}`,
    `ISIN: ${opts.isin}`,
    `AMFI Code: ${opts.amfi}`,
    'Registrar: CAMS',
    '',
    'Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance',
  ];
  for (const r of opts.rows) {
    lines.push(`${r.date}   ${r.desc}                              ${r.amount}  ${r.units}  ${r.nav}  ${r.balance} [Ref: ${r.ref}]`);
  }
  lines.push(`Closing Unit Balance as on ${opts.closing.date} : ${opts.closing.units} Units   Valuation : Rs. ${opts.closing.value}   NAV as on ${opts.closing.date} : Rs. ${opts.closing.nav}`);
  return lines;
}

function camsDocument(blocks: string[][]): string {
  return ['CAMS Consolidated Account Statement', 'Statement Period : 01-Jan-2024 To 31-Aug-2025', '', ...blocks.flatMap((b) => [...b, ''])].join('\n');
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// THE fixture — one scheme, two folios, same AMC / scheme / ISIN / AMFI code.
// ---------------------------------------------------------------------------
const AMC = 'F1 Alpha Mutual Fund';
const SCHEME = 'F1 Alpha Equity Fund - Growth';
const ISIN = 'INF000F1AEQ1';
const AMFI = '920001';
const FOLIO_A = 'F1FOLIOAAA';
const FOLIO_B = 'F1FOLIOBBB';

// A distinct second scheme, held ONLY in Folio A, used to prove the
// (user, account, instrument) key does not collapse to (user, account).
const SCHEME_Y = 'F1 Alpha Debt Fund - Growth';
const ISIN_Y = 'INF000F1ADB2';
const AMFI_Y = '920002';

interface Ground {
  user: SyntheticUser;
  accountA: string;
  accountB: string;
  instrument: string;
  instrumentY: string;
}
let ground: Ground;

afterAll(async () => {
  for (const userId of cleanupUserIds) {
    await admin.from('ii_capital_gains_computations').delete().eq('user_id', userId);
    await admin.from('ii_tax_lot_consumptions').delete().eq('user_id', userId);
    await admin.from('ii_tax_lots').delete().eq('user_id', userId);
    const { data: instrIds } = await admin.from('ii_transactions').select('instrument_id').eq('user_id', userId);
    const uniqueInstrIds = [...new Set((instrIds ?? []).map((r) => r.instrument_id as string))];
    if (uniqueInstrIds.length > 0) await admin.from('ii_scheme_tax_classification').delete().in('instrument_id', uniqueInstrIds);

    const { data: accIds } = await admin.from('ii_accounts').select('id').eq('user_id', userId);
    const accountIds = (accIds ?? []).map((r) => r.id as string);
    if (accountIds.length > 0) {
      await admin.from('ii_portfolio_truth_status').delete().in('account_id', accountIds);
      await admin.from('ii_holding_snapshots').delete().in('account_id', accountIds);
      await admin.from('ii_transactions').delete().in('account_id', accountIds);
    }
    await admin.from('ii_reconciliation_cases').delete().eq('user_id', userId);
    await admin.from('ii_transaction_source_links').delete().eq('user_id', userId);
    const { data: docIds } = await admin.from('ii_source_documents').select('id, storage_path').eq('user_id', userId);
    for (const d of docIds ?? []) {
      await admin.storage.from('investment-source-documents').remove([d.storage_path as string]).catch(() => {});
    }
    await admin.from('ii_document_parse_runs').delete().eq('user_id', userId);
    await admin.from('ii_source_documents').delete().eq('user_id', userId);
    await admin.from('ii_accounts').delete().eq('user_id', userId);

    const { data: hhIds } = await admin.from('households').select('id').eq('user_id', userId);
    for (const hh of hhIds ?? []) await admin.from('household_members').delete().eq('household_id', hh.id as string);
    await admin.from('households').delete().eq('user_id', userId);

    await admin.auth.admin.deleteUser(userId);
  }

  // Zero-residue proof (dispatch §38) — freshly queried, not inferred from
  // delete responses.
  for (const userId of cleanupUserIds) {
    for (const table of [
      'ii_accounts', 'ii_transactions', 'ii_source_documents', 'ii_document_parse_runs',
      'ii_tax_lots', 'ii_tax_lot_consumptions', 'ii_capital_gains_computations',
      'ii_reconciliation_cases', 'households',
    ]) {
      const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId);
      expect(count ?? 0, `residual ${table} for ${userId}`).toBe(0);
    }
    const { data: authUser } = await admin.auth.admin.getUserById(userId);
    expect(authUser?.user ?? null, `residual auth user ${userId}`).toBeNull();
  }
}, 120_000);

// ===========================================================================
// Phase 1 — INITIAL -> JULY -> AUGUST, real parsing and account resolution
// ===========================================================================
describe('F1 Phase 1 — live CAMS ingestion: one scheme, two folios, three documents', () => {
  it('resolves TWO canonical accounts and ONE canonical instrument, across an initial statement and two monthly deltas', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const user = await makeUser('usera', { withHousehold: true });

    // --- INITIAL: Folio A + Folio B, SAME scheme/ISIN. --------------------
    // Folio A's lot is OLDER and CHEAPER than Folio B's — so an
    // instrument-wide FIFO would reach into Folio A for a Folio B redemption.
    const initialText = camsDocument([
      camsLines({
        folio: FOLIO_A, pan: 'ABCDE1111F', name: 'F1 INVESTOR', amc: AMC, scheme: SCHEME, isin: ISIN, amfi: AMFI,
        rows: [{ date: '10-Jan-2024', desc: 'Purchase', amount: '10,000.00', units: '100.000', nav: '100.0000', balance: '100.000', ref: 'F1A-P1' }],
        closing: { date: '30-Jun-2025', units: '100.000', value: '10000.00', nav: '100.0000' },
      }),
      camsLines({
        folio: FOLIO_B, pan: 'ABCDE1111F', name: 'F1 INVESTOR', amc: AMC, scheme: SCHEME, isin: ISIN, amfi: AMFI,
        rows: [{ date: '10-Oct-2024', desc: 'Purchase', amount: '20,000.00', units: '100.000', nav: '200.0000', balance: '100.000', ref: 'F1B-P1' }],
        closing: { date: '30-Jun-2025', units: '100.000', value: '20000.00', nav: '200.0000' },
      }),
      // Second scheme, Folio A only — proves (account, instrument), not (account).
      camsLines({
        folio: FOLIO_A, pan: 'ABCDE1111F', name: 'F1 INVESTOR', amc: AMC, scheme: SCHEME_Y, isin: ISIN_Y, amfi: AMFI_Y,
        rows: [{ date: '05-Feb-2024', desc: 'Purchase', amount: '5,000.00', units: '500.000', nav: '10.0000', balance: '500.000', ref: 'F1A-Y1' }],
        closing: { date: '30-Jun-2025', units: '500.000', value: '5000.00', nav: '10.0000' },
      }),
    ]);
    const initialDocId = await uploadTextStatement(user.userId, user.memberId, 'f1-initial.csv', initialText);
    const initialResult = await processSourceDocument({ userId: user.userId, sourceDocumentId: initialDocId });
    expect(initialResult.ok, `initial process failed: ${initialResult.error}`).toBe(true);

    const { data: accountsAfterInitial } = await admin.from('ii_accounts').select('id, institution_name, folio_number').eq('user_id', user.userId);
    expect(accountsAfterInitial, 'two folios of the SAME AMC must resolve to two distinct canonical accounts').toHaveLength(2);
    const byFolio = new Map((accountsAfterInitial ?? []).map((a) => [a.folio_number as string, a.id as string]));
    const accountA = byFolio.get(FOLIO_A)!;
    const accountB = byFolio.get(FOLIO_B)!;
    expect(accountA).toBeDefined();
    expect(accountB).toBeDefined();
    expect(accountA).not.toBe(accountB); // dispatch §26: A != B, required

    // ONE canonical instrument for the shared ISIN across BOTH folios — this
    // is the precondition that makes the two FIFO models disagree at all.
    const { data: initTxns } = await admin.from('ii_transactions').select('id, account_id, instrument_id, transaction_type, transaction_date, units').eq('user_id', user.userId);
    const sharedIsinTxns = (initTxns ?? []).filter((t) => t.account_id === accountA || t.account_id === accountB);
    const instrumentsInA = new Set(sharedIsinTxns.filter((t) => t.account_id === accountA).map((t) => t.instrument_id as string));
    const instrumentsInB = new Set(sharedIsinTxns.filter((t) => t.account_id === accountB).map((t) => t.instrument_id as string));
    // Folio A holds two schemes; Folio B holds one. The intersection is the shared scheme.
    const shared = [...instrumentsInB].filter((i) => instrumentsInA.has(i));
    expect(shared, 'the same ISIN in two folios must resolve to ONE canonical instrument_id').toHaveLength(1);
    const instrument = shared[0];
    const instrumentY = [...instrumentsInA].find((i) => i !== instrument)!;
    expect(instrumentY).toBeDefined();
    expect(instrumentY).not.toBe(instrument);

    // --- JULY delta: Folio B only. ---------------------------------------
    const julyText = camsDocument([
      camsLines({
        folio: FOLIO_B, pan: 'ABCDE1111F', name: 'F1 INVESTOR', amc: AMC, scheme: SCHEME, isin: ISIN, amfi: AMFI,
        rows: [{ date: '10-Jul-2025', desc: 'Purchase', amount: '15,000.00', units: '50.000', nav: '300.0000', balance: '150.000', ref: 'F1B-P2' }],
        closing: { date: '31-Jul-2025', units: '150.000', value: '45000.00', nav: '300.0000' },
      }),
    ]);
    const julyDocId = await uploadTextStatement(user.userId, user.memberId, 'f1-july.csv', julyText);
    const julyResult = await processSourceDocument({ userId: user.userId, sourceDocumentId: julyDocId });
    expect(julyResult.ok, `july process failed: ${julyResult.error}`).toBe(true);

    // --- AUGUST delta: Folio A purchase + Folio B REDEMPTION. -------------
    const augustText = camsDocument([
      camsLines({
        folio: FOLIO_A, pan: 'ABCDE1111F', name: 'F1 INVESTOR', amc: AMC, scheme: SCHEME, isin: ISIN, amfi: AMFI,
        rows: [{ date: '10-Aug-2025', desc: 'Purchase', amount: '16,000.00', units: '50.000', nav: '320.0000', balance: '150.000', ref: 'F1A-P2' }],
        closing: { date: '31-Aug-2025', units: '150.000', value: '48000.00', nav: '320.0000' },
      }),
      camsLines({
        folio: FOLIO_B, pan: 'ABCDE1111F', name: 'F1 INVESTOR', amc: AMC, scheme: SCHEME, isin: ISIN, amfi: AMFI,
        rows: [{ date: '20-Aug-2025', desc: 'Redemption', amount: '48,000.00', units: '120.000', nav: '400.0000', balance: '30.000', ref: 'F1B-R1' }],
        closing: { date: '31-Aug-2025', units: '30.000', value: '12000.00', nav: '400.0000' },
      }),
    ]);
    const augustDocId = await uploadTextStatement(user.userId, user.memberId, 'f1-august.csv', augustText);
    const augustResult = await processSourceDocument({ userId: user.userId, sourceDocumentId: augustDocId });
    expect(augustResult.ok, `august process failed: ${augustResult.error}`).toBe(true);

    // Account identity is STABLE across all three documents (dispatch §29):
    // no duplicate/shadow folio account was minted by the deltas.
    const { data: accountsFinal } = await admin.from('ii_accounts').select('id, folio_number').eq('user_id', user.userId);
    expect(accountsFinal).toHaveLength(2);
    const finalByFolio = new Map((accountsFinal ?? []).map((a) => [a.folio_number as string, a.id as string]));
    expect(finalByFolio.get(FOLIO_A)).toBe(accountA);
    expect(finalByFolio.get(FOLIO_B)).toBe(accountB);

    ground = { user, accountA, accountB, instrument, instrumentY };
  }, 180_000);
});

// ===========================================================================
// Phase 2 — the real R6 calculation path + independent oracle
// ===========================================================================
describe('F1 Phase 2 — account-scoped FIFO through the real R6 path', () => {
  it('the Folio B redemption consumes FOLIO B lots only, matching an independent oracle on every atomic value', async () => {
    const { loadTaxDataset, persistTaxLots, persistTaxLotConsumptions, persistCapitalGainsComputations } = await import('@/lib/services/investment-intelligence/taxRepository');
    const { runTaxSimulation } = await import('@/lib/engines/investment-intelligence/tax/taxOrchestrator');

    // Reference data only (service-role writable by architecture) — NOT the
    // tax-lot/gains OUTPUT tables, which must come from the engine.
    const { error: classErr } = await admin.from('ii_scheme_tax_classification').insert([
      { instrument_id: ground.instrument, classification: 'equity_oriented', domestic_equity_pct: 85, basis: 'computed_from_holdings', engine_version: 'f1-live-1.0.0' },
      { instrument_id: ground.instrumentY, classification: 'equity_oriented', domestic_equity_pct: 85, basis: 'computed_from_holdings', engine_version: 'f1-live-1.0.0' },
    ]);
    expect(classErr).toBeNull();

    const { dataset, empty } = await loadTaxDataset(ground.user.client, ground.user.userId, {});
    expect(empty).toBe(false);

    // Ground truth from the DB, independent of the engine.
    const { data: allTxns } = await admin.from('ii_transactions').select('id, account_id, instrument_id, transaction_type, transaction_date, units, price_per_unit, gross_amount').eq('user_id', ground.user.userId);
    const txnById = new Map((allTxns ?? []).map((t) => [t.id as string, t]));
    const disposalTxn = (allTxns ?? []).find((t) => t.transaction_type === 'redemption')!;
    expect(disposalTxn, 'the August redemption must have been parsed').toBeDefined();
    expect(disposalTxn.account_id, 'the redemption belongs to Folio B').toBe(ground.accountB);
    expect(Number(disposalTxn.units)).toBeCloseTo(120, 6);

    const acquisitions = [...dataset!.acquisitionsByInstrument.values()].flat();
    const disposals = [...dataset!.disposalsByInstrument.values()].flat();

    // Every acquisition carries its canonical account (dispatch §26).
    for (const a of acquisitions) {
      expect(a.accountKey, `acquisition ${a.sourceEventId} lost its account`).toBe(txnById.get(a.sourceEventId)!.account_id);
    }
    for (const d of disposals) {
      expect(d.accountKey).toBe(txnById.get(d.sourceEventId)!.account_id);
    }

    const result = runTaxSimulation({
      acquisitions,
      disposals,
      classificationByInstrument: dataset!.classificationByInstrument,
      fmv31Jan2018ByInstrument: dataset!.fmv31Jan2018ByInstrument,
      salePricePerUnitByDisposal: dataset!.salePricePerUnitByDisposal,
      exitLoadSchedules: dataset!.exitLoadSchedules,
      residencyProfile: {},
    });

    // ---- INDEPENDENT ORACLE (dispatch §27) -------------------------------
    // Folio B holds: 100 units @ 200 (10-Oct-2024) then 50 units @ 300
    // (10-Jul-2025). Redeeming 120 units @ 400 on 20-Aug-2025 consumes, FIFO
    // WITHIN FOLIO B: all 100 of the October lot, then 20 of the July lot.
    const expected = [
      { units: 100, costPerUnit: 200, acqDate: '2024-10-10', cost: 20_000, proceeds: 40_000, gain: 20_000 },
      { units: 20, costPerUnit: 300, acqDate: '2025-07-10', cost: 6_000, proceeds: 8_000, gain: 2_000 },
    ];

    expect(result.disposalResults, 'exactly two lot consumptions for the one redemption').toHaveLength(2);
    for (const [i, e] of expected.entries()) {
      const a = result.disposalResults[i];
      const lotTxnId = a.lotId.replace(/^lot:/, '');
      const lotTxn = txnById.get(lotTxnId)!;
      expect(lotTxn.account_id, `consumed lot ${a.lotId} must belong to Folio B`).toBe(ground.accountB);
      expect(a.acquisitionDate).toBe(e.acqDate);
      expect(a.unitsConsumed).toBeCloseTo(e.units, 6);
      expect(a.costBasisUsed).toBeCloseTo(e.cost, 4);
      expect(a.saleValue).toBeCloseTo(e.proceeds, 4);
      expect(a.taxableGain!).toBeCloseTo(e.gain, 4);
      expect(a.holdingDays).toBe(daysBetween(e.acqDate, '2025-08-20'));
      expect(a.gainType, 'both Folio B lots were held under 12 months').toBe('stcg');
    }

    // The Folio A lots — older and cheaper — are COMPLETELY untouched.
    const folioALots = result.lots.filter((l) => l.accountKey === ground.accountA);
    expect(folioALots.length).toBeGreaterThan(0);
    for (const l of folioALots) expect(l.unitsRemaining).toBe(l.unitsAcquired);

    // Remaining Folio B units = 150 - 120 = 30, matching the statement's own
    // closing unit balance.
    const folioBRemaining = result.lots.filter((l) => l.accountKey === ground.accountB).reduce((s, l) => s + l.unitsRemaining, 0);
    expect(folioBRemaining).toBeCloseTo(30, 6);

    // ---- What the OLD instrument-wide rule would have produced -----------
    // Recorded for the report: the oldest lot overall is Folio A's 10-Jan-2024
    // lot at cost 100/unit, which would have been LONG-TERM by 20-Aug-2025.
    const oldestOverall = [...result.lots].sort((a, b) => (a.acquisitionDate < b.acquisitionDate ? -1 : 1))[0];
    expect(oldestOverall.accountKey, 'sanity: the globally-oldest lot is indeed in the NON-disposing folio').toBe(ground.accountA);
    expect(daysBetween(oldestOverall.acquisitionDate, '2025-08-20')).toBeGreaterThan(365); // would have been LTCG

    // ---- Persist through the real path, then verify PERSISTED state ------
    const lotsPersist = await persistTaxLots(ground.user.userId, result.lots);
    expect(lotsPersist.error, `persistTaxLots error: ${lotsPersist.error}`).toBeNull();
    const consPersist = await persistTaxLotConsumptions(ground.user.userId, result.disposalResults);
    expect(consPersist.error, `persistTaxLotConsumptions error: ${consPersist.error}`).toBeNull();
    const cgPersist = await persistCapitalGainsComputations(ground.user.userId, result.disposalResults, result.exitLoadResults);
    expect(cgPersist.error, `persistCapitalGainsComputations error: ${cgPersist.error}`).toBeNull();

    // ---- CROSS-ACCOUNT CONTAMINATION ORACLE, against PERSISTED rows ------
    const { data: persistedLots } = await admin.from('ii_tax_lots').select('id, account_id, instrument_id, units_acquired, units_remaining').eq('user_id', ground.user.userId);
    const lotAccountById = new Map((persistedLots ?? []).map((l) => [l.id as string, l.account_id as string]));
    const { data: persistedCons } = await admin.from('ii_tax_lot_consumptions').select('id, disposal_transaction_id, lot_id, units_consumed').eq('user_id', ground.user.userId);
    expect((persistedCons ?? []).length, 'both consumptions persisted').toBe(2);

    let contamination = 0;
    for (const c of persistedCons ?? []) {
      const disposalAccount = txnById.get(c.disposal_transaction_id as string)!.account_id as string;
      const lotAccount = lotAccountById.get(c.lot_id as string)!;
      if (disposalAccount !== lotAccount) contamination++;
    }
    expect(contamination, 'a disposal consumed a lot acquired under a DIFFERENT folio — cross-account financial contamination').toBe(0);

    // Persisted lot account_id agrees with canonical transaction truth.
    for (const l of persistedLots ?? []) {
      expect([ground.accountA, ground.accountB]).toContain(l.account_id);
    }

    // §34 net-worth non-duplication: each folio's OPEN cost basis is exactly
    // what that folio genuinely holds. This is the figure R3's
    // investmentPublicationService reads back per (account_id, instrument_id).
    const openUnits = (account: string, instrument: string) =>
      (persistedLots ?? []).filter((l) => l.account_id === account && l.instrument_id === instrument).reduce((s, l) => s + Number(l.units_remaining), 0);
    expect(openUnits(ground.accountA, ground.instrument)).toBeCloseTo(150, 6); // 100 + 50, never decremented by Folio B's redemption
    expect(openUnits(ground.accountB, ground.instrument)).toBeCloseTo(30, 6);
    expect(openUnits(ground.accountA, ground.instrumentY)).toBeCloseTo(500, 6); // second scheme untouched
    expect(openUnits(ground.accountB, ground.instrumentY)).toBeCloseTo(0, 6); // Folio B never held it
  }, 180_000);

  it('§28 recomputation is idempotent — identical results, no duplicate persisted rows', async () => {
    const { loadTaxDataset, persistTaxLots, persistTaxLotConsumptions, persistCapitalGainsComputations } = await import('@/lib/services/investment-intelligence/taxRepository');
    const { runTaxSimulation } = await import('@/lib/engines/investment-intelligence/tax/taxOrchestrator');

    const runOnce = async () => {
      const { dataset } = await loadTaxDataset(ground.user.client, ground.user.userId, {});
      const result = runTaxSimulation({
        acquisitions: [...dataset!.acquisitionsByInstrument.values()].flat(),
        disposals: [...dataset!.disposalsByInstrument.values()].flat(),
        classificationByInstrument: dataset!.classificationByInstrument,
        fmv31Jan2018ByInstrument: dataset!.fmv31Jan2018ByInstrument,
        salePricePerUnitByDisposal: dataset!.salePricePerUnitByDisposal,
        exitLoadSchedules: dataset!.exitLoadSchedules,
        residencyProfile: {},
      });
      await persistTaxLots(ground.user.userId, result.lots);
      await persistTaxLotConsumptions(ground.user.userId, result.disposalResults);
      await persistCapitalGainsComputations(ground.user.userId, result.disposalResults, result.exitLoadResults);
      return result;
    };

    const before = await runOnce();
    const after = await runOnce();

    expect(JSON.stringify(after.disposalResults)).toBe(JSON.stringify(before.disposalResults));
    expect(after.engineVersion).toBe(before.engineVersion);

    // No duplicated persisted calculations.
    const { count: lotCount } = await admin.from('ii_tax_lots').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId);
    const { count: consCount } = await admin.from('ii_tax_lot_consumptions').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId);
    const { count: cgCount } = await admin.from('ii_capital_gains_computations').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId);
    expect(lotCount).toBe(before.lots.length);
    expect(consCount).toBe(2);
    expect(cgCount).toBe(2);
  }, 180_000);

  it('§29 longitudinal — historical Folio A attribution is not mutated by the later monthly activity', async () => {
    const { data: lots } = await admin.from('ii_tax_lots').select('id, account_id, instrument_id, acquisition_date, units_acquired, units_remaining, opening_transaction_id').eq('user_id', ground.user.userId).eq('account_id', ground.accountA);
    // Folio A's original 10-Jan-2024 lot still exists, still belongs to Folio
    // A, and still holds all 100 units despite two subsequent documents and a
    // 120-unit redemption elsewhere in the same scheme.
    const jan = (lots ?? []).find((l) => l.acquisition_date === '2024-01-10' && l.instrument_id === ground.instrument)!;
    expect(jan, "Folio A's original January lot must still exist").toBeDefined();
    expect(jan.account_id).toBe(ground.accountA);
    expect(Number(jan.units_remaining)).toBeCloseTo(100, 6);
    // The August delta EXTENDED Folio A's own sequence rather than rewriting it.
    const aug = (lots ?? []).find((l) => l.acquisition_date === '2025-08-10')!;
    expect(aug).toBeDefined();
    expect(aug.account_id).toBe(ground.accountA);
    expect(Number(aug.units_remaining)).toBeCloseTo(50, 6);
  }, 60_000);
});

// ===========================================================================
// Phase 3 — security (dispatch §30, §31)
// ===========================================================================
describe('F1 Phase 3 — security: account_id is canonical truth, never client-assertable', () => {
  it('§30 a second real user cannot read or reference this user\'s accounts, lots or consumptions', async () => {
    const userB = await makeUser('userb', { withHousehold: true });

    // Cross-user reads via userB's REAL JWT (RLS-respecting).
    const { data: bReadsAccounts } = await userB.client.from('ii_accounts').select('*').eq('user_id', ground.user.userId);
    expect(bReadsAccounts ?? []).toHaveLength(0);
    const { data: bReadsLots } = await userB.client.from('ii_tax_lots').select('*').eq('user_id', ground.user.userId);
    expect(bReadsLots ?? []).toHaveLength(0);
    const { data: bReadsCons } = await userB.client.from('ii_tax_lot_consumptions').select('*').eq('user_id', ground.user.userId);
    expect(bReadsCons ?? []).toHaveLength(0);
    const { data: bReadsTxns } = await userB.client.from('ii_transactions').select('*').eq('account_id', ground.accountB);
    expect(bReadsTxns ?? []).toHaveLength(0);

    // VALID-FK forgery: userB tries to insert a tax lot pointing at userA's
    // REAL account_id and REAL instrument_id (both valid FKs, so this cannot
    // be deflected by referential integrity — only RLS can stop it).
    const { data: forgedLot, error: forgeErr } = await userB.client.from('ii_tax_lots').insert({
      user_id: userB.userId, // even claiming his OWN user_id
      account_id: ground.accountA, // ...but another user's account
      instrument_id: ground.instrument,
      status: 'open',
      acquisition_date: '2020-01-01',
      units_acquired: 1_000_000,
      units_remaining: 1_000_000,
      cost_per_unit: 0.01,
    }).select('id');
    expect(forgeErr, 'valid-FK cross-tenant tax-lot insert must be REJECTED').not.toBeNull();
    expect(forgedLot ?? []).toHaveLength(0);

    // PERSISTED-STATE proof, not merely the HTTP response: nothing landed.
    const { count: forgedCount } = await admin.from('ii_tax_lots').select('id', { count: 'exact', head: true }).eq('account_id', ground.accountA).eq('user_id', userB.userId);
    expect(forgedCount ?? 0).toBe(0);

    // And userA's own FIFO is unchanged by the attempt.
    const { count: aLotCount } = await admin.from('ii_tax_lots').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId).eq('account_id', ground.accountA);
    expect((aLotCount ?? 0) > 0).toBe(true);
  }, 120_000);

  it('§31 the redemption simulator can only SELECT from accounts canonical truth says hold the instrument', async () => {
    const { loadTaxDataset } = await import('@/lib/services/investment-intelligence/taxRepository');
    const { dataset } = await loadTaxDataset(ground.user.client, ground.user.userId, {});

    // The shared scheme is held in BOTH folios...
    const holders = dataset!.accountIdsByInstrument.get(ground.instrument) ?? [];
    expect(new Set(holders)).toEqual(new Set([ground.accountA, ground.accountB]));

    // ...but the SECOND scheme is held in Folio A ONLY. A crafted request
    // naming Folio B for instrument Y is therefore rejected by the route's
    // guard, because the association comes from canonical transaction truth
    // rather than from the request body.
    const holdersY = dataset!.accountIdsByInstrument.get(ground.instrumentY) ?? [];
    expect(holdersY).toEqual([ground.accountA]);
    expect(holdersY).not.toContain(ground.accountB);

    // Folio labels resolve for user-facing disambiguation and are read
    // through the RLS-respecting client, so they can only ever be this
    // user's own folios.
    expect(dataset!.accountLabels.get(ground.accountA)).toContain(FOLIO_A);
    expect(dataset!.accountLabels.get(ground.accountB)).toContain(FOLIO_B);
  }, 60_000);
});
