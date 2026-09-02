// II-PC1-F2 — R6 STALE ENGINE-VERSION CONSUMER REVIEW, LIVE HOSTED-DEV.
//
// THE ONLY QUESTION THIS SUITE EXISTS TO SETTLE
// ---------------------------------------------
// Can a user ever be shown an old R6 v2 result after a correct v3 result
// exists?
//
// II-PC1-F1 bumped TAX_ENGINE_VERSION v2 -> v3 because FIFO lot candidacy
// changed from (instrument) to (account, instrument). For a user holding one
// scheme in two folios that changes WHICH lot a disposal consumes. The
// persisted derived tables key their upserts on (disposal_transaction_id,
// lot_id) — so when the consumed lot changes, the v3 write lands on a NEW
// key and the v2 row is NOT overwritten. It is orphaned, and nothing in the
// product ever deletes it.
//
// This suite reproduces that coexistence against real DEV and then drives
// every real consumer over it.
//
// FIXTURE PROVENANCE: the CAMS document set, the folio/scheme identities and
// every monetary value below are copied verbatim from
// tests/live-dev/iiPc1F1FifoAccountScopeLiveDev.test.ts, so F1's already-
// certified oracle applies here unchanged (dispatch §9, §30). Two additions
// F1 did not need: a scheme tax classification and an exit-load schedule
// with a 1095-day tier, so that `exit_load_pct` is non-zero on BOTH the v2
// and the v3 rows — that is the input Review Centre's exit_load_exposure
// rule actually consumes, and without it the rule cannot be exercised at all.
//
// HOW THE HISTORICAL v2 STATE IS PRODUCED (dispatch §10)
// ------------------------------------------------------
// Preference order in the dispatch is: existing fixtures, then service-layer
// machinery, then direct fixture insertion. This suite uses the SECOND
// option for the financial values and only the third for the version label:
//
//   * The v2 FINANCIAL RESULT is produced by the REAL, CURRENT engine —
//     `runTaxSimulation` — replayed with every accountKey collapsed to one
//     sentinel value. Collapsing the account makes the (account, instrument)
//     candidacy predicate degenerate to (instrument), which IS precisely the
//     v2 rule. No hand-written gain, cost basis or holding period appears
//     anywhere below; the old numbers are the old engine's own output.
//   * Only the `engine_version` string and the INSERT itself are fixture.
//     This is explicitly consumer-state simulation — reproducing a database
//     state that a pre-F1 production run would have left behind — and is
//     NOT a claim that the ingestion path can still produce v2 rows.
//
// RLS is never bypassed to claim an authorisation PASS: every security
// assertion below uses a real second user's real JWT (dispatch §25).

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
const RUN_TAG = `f2-${STAMP}`;
const cleanupUserIds: string[] = [];
const cleanupInstrumentIds = new Set<string>();

const V2_ENGINE = 'tax-engine-r6-p1-v2';
const V3_ENGINE = 'tax-engine-r6-p1-v3';

interface SyntheticUser {
  userId: string;
  email: string;
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
    const { data: hh, error: hhErr } = await admin.from('households').insert({ user_id: data.user.id, household_name: `F2 ${tag}`, primary_country: 'IN' }).select('id').single();
    if (hhErr || !hh) throw new Error(`household insert failed for ${tag}: ${hhErr?.message}`);
    const { data: mem, error: memErr } = await admin
      .from('household_members')
      .insert({ user_id: data.user.id, household_id: hh.id, full_name: `F2 Test Self ${tag}`, relationship: 'self' })
      .select('id')
      .single();
    if (memErr || !mem) throw new Error(`household_member insert failed for ${tag}: ${memErr?.message}`);
    memberId = mem.id as string;
  }
  return { userId: data.user.id, email, client, memberId };
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

// ---------------------------------------------------------------------------
// F1's fixture identities, verbatim.
// ---------------------------------------------------------------------------
const AMC = 'F2 Alpha Mutual Fund';
const SCHEME = 'F2 Alpha Equity Fund - Growth';
const ISIN = 'INF000F2AEQ1';
const AMFI = '930001';
const FOLIO_A = 'F2FOLIOAAA';
const FOLIO_B = 'F2FOLIOBBB';

interface Ground {
  user: SyntheticUser;
  accountA: string;
  accountB: string;
  instrument: string;
  disposalTxnId: string;
  lotAJanId: string; // the Folio A 10-Jan-2024 lot — what v2 wrongly consumed
}
let ground: Ground;

// Captured across phases for the report.
const evidence: Record<string, unknown> = {};

async function loadDataset(user: SyntheticUser) {
  const { loadTaxDataset } = await import('@/lib/services/investment-intelligence/taxRepository');
  const { dataset, empty } = await loadTaxDataset(user.client, user.userId, {});
  if (empty || !dataset) throw new Error('dataset unexpectedly empty');
  return dataset;
}

async function runV3(user: SyntheticUser) {
  const { runTaxSimulation } = await import('@/lib/engines/investment-intelligence/tax/taxOrchestrator');
  const dataset = await loadDataset(user);
  return runTaxSimulation({
    acquisitions: [...dataset.acquisitionsByInstrument.values()].flat(),
    disposals: [...dataset.disposalsByInstrument.values()].flat(),
    classificationByInstrument: dataset.classificationByInstrument,
    fmv31Jan2018ByInstrument: dataset.fmv31Jan2018ByInstrument,
    salePricePerUnitByDisposal: dataset.salePricePerUnitByDisposal,
    exitLoadSchedules: dataset.exitLoadSchedules,
    residencyProfile: {},
  });
}

/** The OLD v2 rule, produced by the CURRENT engine with account candidacy
 * collapsed — see this file's header. No hand-written financial values. */
async function runV2Equivalent(user: SyntheticUser) {
  const { runTaxSimulation } = await import('@/lib/engines/investment-intelligence/tax/taxOrchestrator');
  const dataset = await loadDataset(user);
  const COLLAPSED = 'v2-instrument-wide-candidacy';
  return runTaxSimulation({
    acquisitions: [...dataset.acquisitionsByInstrument.values()].flat().map((a) => ({ ...a, accountKey: COLLAPSED })),
    disposals: [...dataset.disposalsByInstrument.values()].flat().map((d) => ({ ...d, accountKey: COLLAPSED })),
    classificationByInstrument: dataset.classificationByInstrument,
    fmv31Jan2018ByInstrument: dataset.fmv31Jan2018ByInstrument,
    salePricePerUnitByDisposal: dataset.salePricePerUnitByDisposal,
    exitLoadSchedules: dataset.exitLoadSchedules,
    residencyProfile: {},
  });
}

afterAll(async () => {
  for (const userId of cleanupUserIds) {
    await admin.from('ii_review_items').delete().eq('user_id', userId);
    await admin.from('ii_capital_gains_computations').delete().eq('user_id', userId);
    await admin.from('ii_tax_lot_consumptions').delete().eq('user_id', userId);
    await admin.from('ii_tax_lots').delete().eq('user_id', userId);

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
  // Reference data this suite created (instrument-scoped, not user-scoped).
  for (const instrumentId of cleanupInstrumentIds) {
    await admin.from('ii_exit_load_schedules').delete().eq('instrument_id', instrumentId);
    await admin.from('ii_scheme_tax_classification').delete().eq('instrument_id', instrumentId);
  }

  // Zero-residue proof (dispatch §35) — freshly queried, never inferred from
  // the delete responses above.
  for (const userId of cleanupUserIds) {
    for (const table of [
      'ii_accounts', 'ii_transactions', 'ii_source_documents', 'ii_document_parse_runs',
      'ii_tax_lots', 'ii_tax_lot_consumptions', 'ii_capital_gains_computations',
      'ii_review_items', 'ii_reconciliation_cases', 'households',
    ]) {
      const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId);
      expect(count ?? 0, `residual ${table} for ${userId}`).toBe(0);
    }
    const { data: authUser } = await admin.auth.admin.getUserById(userId);
    expect(authUser?.user ?? null, `residual auth user ${userId}`).toBeNull();
  }
  for (const instrumentId of cleanupInstrumentIds) {
    const { count: elc } = await admin.from('ii_exit_load_schedules').select('id', { count: 'exact', head: true }).eq('instrument_id', instrumentId);
    expect(elc ?? 0, `residual ii_exit_load_schedules for ${instrumentId}`).toBe(0);
    const { count: scc } = await admin.from('ii_scheme_tax_classification').select('id', { count: 'exact', head: true }).eq('instrument_id', instrumentId);
    expect(scc ?? 0, `residual ii_scheme_tax_classification for ${instrumentId}`).toBe(0);
  }

  // Evidence is written to a file rather than stdout: vitest suppresses hook
  // console output on a passing run, which is exactly the run whose evidence
  // matters most. Path is gitignored scratch, never committed.
  const evidenceDir = path.join(repoRoot, '_f2_tmp');
  if (fs.existsSync(evidenceDir)) {
    fs.writeFileSync(path.join(evidenceDir, 'f2_evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  }
}, 180_000);

// ===========================================================================
// Phase 0 — real ingestion (F1's fixture) + reference data
// ===========================================================================
describe('F2 Phase 0 — live CAMS ingestion: one scheme, two folios', () => {
  it('resolves TWO canonical accounts and ONE canonical instrument, and books the Folio B redemption', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const user = await makeUser('owner', { withHousehold: true });

    const initialText = camsDocument([
      camsLines({
        folio: FOLIO_A, pan: 'ABCDE2222F', name: 'F2 INVESTOR', amc: AMC, scheme: SCHEME, isin: ISIN, amfi: AMFI,
        rows: [{ date: '10-Jan-2024', desc: 'Purchase', amount: '10,000.00', units: '100.000', nav: '100.0000', balance: '100.000', ref: 'F2A-P1' }],
        closing: { date: '30-Jun-2025', units: '100.000', value: '10000.00', nav: '100.0000' },
      }),
      camsLines({
        folio: FOLIO_B, pan: 'ABCDE2222F', name: 'F2 INVESTOR', amc: AMC, scheme: SCHEME, isin: ISIN, amfi: AMFI,
        rows: [{ date: '10-Oct-2024', desc: 'Purchase', amount: '20,000.00', units: '100.000', nav: '200.0000', balance: '100.000', ref: 'F2B-P1' }],
        closing: { date: '30-Jun-2025', units: '100.000', value: '20000.00', nav: '200.0000' },
      }),
    ]);
    const initialDocId = await uploadTextStatement(user.userId, user.memberId, 'f2-initial.csv', initialText);
    const initialResult = await processSourceDocument({ userId: user.userId, sourceDocumentId: initialDocId });
    expect(initialResult.ok, `initial process failed: ${initialResult.error}`).toBe(true);

    const julyText = camsDocument([
      camsLines({
        folio: FOLIO_B, pan: 'ABCDE2222F', name: 'F2 INVESTOR', amc: AMC, scheme: SCHEME, isin: ISIN, amfi: AMFI,
        rows: [{ date: '10-Jul-2025', desc: 'Purchase', amount: '15,000.00', units: '50.000', nav: '300.0000', balance: '150.000', ref: 'F2B-P2' }],
        closing: { date: '31-Jul-2025', units: '150.000', value: '45000.00', nav: '300.0000' },
      }),
    ]);
    const julyDocId = await uploadTextStatement(user.userId, user.memberId, 'f2-july.csv', julyText);
    expect((await processSourceDocument({ userId: user.userId, sourceDocumentId: julyDocId })).ok).toBe(true);

    const augustText = camsDocument([
      camsLines({
        folio: FOLIO_A, pan: 'ABCDE2222F', name: 'F2 INVESTOR', amc: AMC, scheme: SCHEME, isin: ISIN, amfi: AMFI,
        rows: [{ date: '10-Aug-2025', desc: 'Purchase', amount: '16,000.00', units: '50.000', nav: '320.0000', balance: '150.000', ref: 'F2A-P2' }],
        closing: { date: '31-Aug-2025', units: '150.000', value: '48000.00', nav: '320.0000' },
      }),
      camsLines({
        folio: FOLIO_B, pan: 'ABCDE2222F', name: 'F2 INVESTOR', amc: AMC, scheme: SCHEME, isin: ISIN, amfi: AMFI,
        rows: [{ date: '20-Aug-2025', desc: 'Redemption', amount: '48,000.00', units: '120.000', nav: '400.0000', balance: '30.000', ref: 'F2B-R1' }],
        closing: { date: '31-Aug-2025', units: '30.000', value: '12000.00', nav: '400.0000' },
      }),
    ]);
    const augustDocId = await uploadTextStatement(user.userId, user.memberId, 'f2-august.csv', augustText);
    expect((await processSourceDocument({ userId: user.userId, sourceDocumentId: augustDocId })).ok).toBe(true);

    const { data: accounts } = await admin.from('ii_accounts').select('id, folio_number').eq('user_id', user.userId);
    expect(accounts, 'two folios must resolve to two canonical accounts').toHaveLength(2);
    const byFolio = new Map((accounts ?? []).map((a) => [a.folio_number as string, a.id as string]));
    const accountA = byFolio.get(FOLIO_A)!;
    const accountB = byFolio.get(FOLIO_B)!;
    expect(accountA).not.toBe(accountB);

    const { data: txns } = await admin.from('ii_transactions').select('id, account_id, instrument_id, transaction_type, transaction_date').eq('user_id', user.userId);
    const instruments = new Set((txns ?? []).map((t) => t.instrument_id as string));
    expect(instruments.size, 'the shared ISIN must resolve to ONE canonical instrument').toBe(1);
    const instrument = [...instruments][0];
    cleanupInstrumentIds.add(instrument);

    const disposal = (txns ?? []).find((t) => t.transaction_type === 'redemption')!;
    expect(disposal, 'the August redemption must have parsed').toBeDefined();
    expect(disposal.account_id, 'the redemption belongs to Folio B').toBe(accountB);

    const janTxn = (txns ?? []).find((t) => t.account_id === accountA && t.transaction_date === '2024-01-10')!;
    expect(janTxn, 'the Folio A 10-Jan-2024 acquisition must exist').toBeDefined();

    // Reference data. The 1095-day tier makes exit_load_pct non-zero for
    // EVERY lot in this fixture, which is what lets Review Centre's
    // exit_load_exposure rule be exercised at all.
    const { error: classErr } = await admin.from('ii_scheme_tax_classification').insert({
      instrument_id: instrument, classification: 'equity_oriented', domestic_equity_pct: 85,
      basis: 'computed_from_holdings', engine_version: 'f2-live-1.0.0',
    });
    expect(classErr).toBeNull();
    const { error: elErr } = await admin.from('ii_exit_load_schedules').insert({
      instrument_id: instrument, tiers: [{ uptoDays: 1095, loadPct: 1 }], effective_from: '2020-01-01', effective_to: null,
    });
    expect(elErr).toBeNull();

    ground = { user, accountA, accountB, instrument, disposalTxnId: disposal.id as string, lotAJanId: janTxn.id as string };
  }, 240_000);
});

// ===========================================================================
// Phase 1 — v2 / v3 coexistence (dispatch §9, §10)
// ===========================================================================
describe('F2 Phase 1 — historical v2 and current v3 coexist in the persisted tables', () => {
  it('F2-T01/T02 — the v2 rule and the v3 rule produce materially DIFFERENT answers, and both rows survive', async () => {
    const { persistTaxLots, persistTaxLotConsumptions, persistCapitalGainsComputations, deterministicLotId } =
      await import('@/lib/services/investment-intelligence/taxRepository');

    // ---- T0: the historical v2 state -----------------------------------
    const v2 = await runV2Equivalent(ground.user);
    // Lots must exist first: ii_capital_gains_computations.lot_id is a
    // NOT NULL FK into ii_tax_lots.
    const lotsPersist = await persistTaxLots(ground.user.userId, (await runV3(ground.user)).lots);
    expect(lotsPersist.error, `persistTaxLots: ${lotsPersist.error}`).toBeNull();

    const v2ExitByLot = new Map(v2.exitLoadResults.map((e) => [`${e.disposalEventId}:${e.lotId}`, e]));
    const v2Payload = v2.disposalResults.map((d) => {
      const el = v2ExitByLot.get(`${d.disposalEventId}:${d.lotId}`);
      return {
        user_id: ground.user.userId,
        disposal_transaction_id: d.disposalEventId,
        lot_id: deterministicLotId(d.lotId),
        instrument_id: d.instrumentKey,
        classification: d.classification,
        gain_type: d.gainType,
        holding_days: d.holdingDays,
        rule_version: d.ruleVersion,
        rule_version_placeholder: d.ruleVersionPlaceholder,
        sale_value: d.saleValue,
        cost_basis_used: d.costBasisUsed,
        taxable_gain: d.taxableGain,
        grandfathering_eligible: d.grandfathering?.eligible ?? false,
        grandfathering_basis_source: d.grandfathering?.basisSource ?? null,
        exit_load_pct: el?.applicableLoadPct ?? null,
        exit_load_amount: el?.exitLoadAmount ?? null,
        engine_version: V2_ENGINE, // <- the ONLY fixture value in this payload
        note: d.note,
      };
    });
    const { error: v2Err } = await admin.from('ii_capital_gains_computations').insert(v2Payload);
    expect(v2Err, `v2 fixture insert: ${v2Err?.message}`).toBeNull();
    const { error: v2ConsErr } = await admin.from('ii_tax_lot_consumptions').insert(
      v2.disposalResults.filter((d) => d.classification !== 'unresolved').map((d) => ({
        user_id: ground.user.userId,
        disposal_transaction_id: d.disposalEventId,
        lot_id: deterministicLotId(d.lotId),
        units_consumed: d.unitsConsumed,
        cost_basis_pre_grandfathering: d.costBasisPreGrandfathering,
        sale_value_apportioned: d.saleValue,
        engine_version: V2_ENGINE,
      }))
    );
    expect(v2ConsErr, `v2 consumption fixture insert: ${v2ConsErr?.message}`).toBeNull();

    // The v2 rule reached into Folio A — that is the defect F1 fixed, and it
    // is the reason the (disposal, lot) upsert key changes under v3.
    const v2ConsumedLotTxnIds = v2.disposalResults.map((d) => d.lotId.replace(/^lot:/, ''));
    expect(v2ConsumedLotTxnIds, 'the v2 rule must have consumed the Folio A January lot').toContain(ground.lotAJanId);

    // ---- T1: the current v3 state, through the REAL persistence path ----
    const v3 = await runV3(ground.user);
    expect(v3.engineVersion).toBe(V3_ENGINE);
    const consPersist = await persistTaxLotConsumptions(ground.user.userId, v3.disposalResults);
    expect(consPersist.error, `persistTaxLotConsumptions: ${consPersist.error}`).toBeNull();
    const cgPersist = await persistCapitalGainsComputations(ground.user.userId, v3.disposalResults, v3.exitLoadResults);
    expect(cgPersist.error, `persistCapitalGainsComputations: ${cgPersist.error}`).toBeNull();

    // ---- v3 agrees with F1's certified oracle ---------------------------
    const expectedV3 = [
      { units: 100, acqDate: '2024-10-10', cost: 20_000, proceeds: 40_000, gain: 20_000 },
      { units: 20, acqDate: '2025-07-10', cost: 6_000, proceeds: 8_000, gain: 2_000 },
    ];
    expect(v3.disposalResults).toHaveLength(2);
    for (const [i, e] of expectedV3.entries()) {
      const a = v3.disposalResults[i];
      expect(a.acquisitionDate).toBe(e.acqDate);
      expect(a.unitsConsumed).toBeCloseTo(e.units, 6);
      expect(a.costBasisUsed).toBeCloseTo(e.cost, 4);
      expect(a.taxableGain!).toBeCloseTo(e.gain, 4);
      expect(a.gainType, 'both Folio B lots were held under 12 months').toBe('stcg');
    }

    // ---- the two answers genuinely disagree (dispatch §9) ---------------
    const v2TotalGain = v2.disposalResults.reduce((s, d) => s + (d.taxableGain ?? 0), 0);
    const v3TotalGain = v3.disposalResults.reduce((s, d) => s + (d.taxableGain ?? 0), 0);
    expect(v2TotalGain).not.toBeCloseTo(v3TotalGain, 2);
    expect(v2.disposalResults.some((d) => d.gainType === 'ltcg'), 'v2 mis-classified part of the disposal as long-term').toBe(true);
    expect(v3.disposalResults.every((d) => d.gainType === 'stcg'), 'v3 correctly classifies the whole disposal as short-term').toBe(true);

    // ---- COEXISTENCE, read back from the real table ---------------------
    const { data: persisted } = await admin
      .from('ii_capital_gains_computations')
      .select('id, disposal_transaction_id, lot_id, gain_type, taxable_gain, exit_load_pct, engine_version, computed_at')
      .eq('user_id', ground.user.userId);
    const v2Rows = (persisted ?? []).filter((r) => r.engine_version === V2_ENGINE);
    const v3Rows = (persisted ?? []).filter((r) => r.engine_version === V3_ENGINE);

    expect(v3Rows.length, 'the current v3 computation is persisted').toBeGreaterThan(0);
    expect(v2Rows.length, 'AT LEAST ONE historical v2 row survived the v3 recomputation — it was never overwritten because the consumed lot changed, so the (disposal, lot) upsert key changed').toBeGreaterThan(0);

    // The surviving v2 row points at the Folio A lot, which under v3 is not
    // part of this disposal at all — there is NO v3 row for that lot.
    const orphanLotId = deterministicLotId(`lot:${ground.lotAJanId}`);
    const orphan = v2Rows.find((r) => r.lot_id === orphanLotId);
    expect(orphan, 'the orphaned v2 row is the Folio A January lot').toBeDefined();
    expect(v3Rows.some((r) => r.lot_id === orphanLotId), 'no v3 row exists for that lot — the orphan is unreachable by any upsert').toBe(false);

    evidence.coexistence = {
      v2RowCount: v2Rows.length,
      v3RowCount: v3Rows.length,
      v2TotalTaxableGain: v2TotalGain,
      v3TotalTaxableGain: v3TotalGain,
      orphanV2Row: orphan ? { lot_id: orphan.lot_id, gain_type: orphan.gain_type, taxable_gain: orphan.taxable_gain, exit_load_pct: orphan.exit_load_pct, engine_version: orphan.engine_version } : null,
    };
  }, 240_000);

  it('F2-T03/T12 — a repeated v3 recomputation is deterministic and creates no duplicate rows', async () => {
    const { persistTaxLots, persistTaxLotConsumptions, persistCapitalGainsComputations } =
      await import('@/lib/services/investment-intelligence/taxRepository');
    const before = await admin.from('ii_capital_gains_computations').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId);

    const runs = [];
    for (let i = 0; i < 3; i++) {
      const r = await runV3(ground.user);
      await persistTaxLots(ground.user.userId, r.lots);
      await persistTaxLotConsumptions(ground.user.userId, r.disposalResults);
      await persistCapitalGainsComputations(ground.user.userId, r.disposalResults, r.exitLoadResults);
      runs.push(r.disposalResults.map((d) => `${d.lotId}:${d.unitsConsumed}:${d.costBasisUsed}:${d.taxableGain}:${d.gainType}`).join('|'));
    }
    expect(new Set(runs).size, 'three consecutive recomputations must be byte-identical').toBe(1);

    const after = await admin.from('ii_capital_gains_computations').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId);
    expect(after.count, 'repeated recomputation must not add rows').toBe(before.count);
  }, 240_000);
});

// ===========================================================================
// Phase 2 — THE PRIMARY RED QUESTION: Review Centre (dispatch §11)
// ===========================================================================
describe('F2 Phase 2 — Review Centre over a v2/v3 mixed table', () => {
  it('F2-T06 — the REAL Review Centre refresh must not derive any item from a superseded v2 row', async () => {
    const { runReviewCentreRefresh } = await import('@/lib/services/investment-intelligence/reviewCentreData');
    const refresh = await runReviewCentreRefresh(ground.user.userId);
    expect(refresh.error, `review refresh failed: ${refresh.error}`).toBeNull();

    const { data: items } = await admin
      .from('ii_review_items')
      .select('id, category, status, title, description, evidence, source_module, source_record_id, source_record_version')
      .eq('user_id', ground.user.userId)
      .eq('source_module', 'ii_r6_tax');

    const staleItems = (items ?? []).filter((i) => i.source_record_version === V2_ENGINE);
    evidence.reviewCentre = {
      totalR6Items: (items ?? []).length,
      byVersion: (items ?? []).reduce((acc: Record<string, number>, i) => {
        acc[i.source_record_version as string] = (acc[i.source_record_version as string] ?? 0) + 1;
        return acc;
      }, {}),
      staleItems: staleItems.map((i) => ({
        category: i.category, status: i.status, title: i.title,
        source_record_id: i.source_record_id, source_record_version: i.source_record_version,
        evidence: i.evidence,
      })),
    };

    expect(
      staleItems.length,
      `Review Centre surfaced ${staleItems.length} review item(s) derived from superseded ${V2_ENGINE} rows after a correct ${V3_ENGINE} result existed. ` +
        `Details: ${JSON.stringify(staleItems.map((i) => ({ category: i.category, src: i.source_record_id, ver: i.source_record_version })))}`
    ).toBe(0);

    // The CORRECT v3 observations are still produced — the fix suppresses
    // stale rows, it does not silence the rule.
    expect((items ?? []).filter((i) => i.source_record_version === V3_ENGINE).length, 'current-version review items must still be raised').toBeGreaterThan(0);
  }, 240_000);

  it('F2-T15 (§15) — the superseded v2 row is RETAINED, not deleted, to preserve calculation provenance', async () => {
    const { deterministicLotId } = await import('@/lib/services/investment-intelligence/taxRepository');
    const orphanLotId = deterministicLotId(`lot:${ground.lotAJanId}`);
    const { data } = await admin
      .from('ii_capital_gains_computations')
      .select('id, lot_id, engine_version, gain_type, taxable_gain')
      .eq('user_id', ground.user.userId)
      .eq('lot_id', orphanLotId);
    expect(data ?? [], 'the historical v2 row must still exist — F2 supersedes by selection, never by deletion').toHaveLength(1);
    expect(data![0].engine_version).toBe(V2_ENGINE);
    evidence.historyPreserved = { orphanRowStillPresent: true, engine_version: data![0].engine_version, taxable_gain: data![0].taxable_gain };
  }, 120_000);

  it('F2-T13 — a user with ONLY superseded rows yields no current-derived items, not an arbitrary historical row', async () => {
    const { selectCurrentCapitalGainsRows, loadCurrentCapitalGainsComputations } =
      await import('@/lib/services/investment-intelligence/taxRepository');

    // Pure-rule check: a v2-only row set has no current member.
    expect(selectCurrentCapitalGainsRows([
      { disposal_transaction_id: 'd1', engine_version: V2_ENGINE, computed_at: '2026-08-22T00:00:00Z' },
      { disposal_transaction_id: 'd1', engine_version: V2_ENGINE, computed_at: '2026-08-23T00:00:00Z' },
    ])).toHaveLength(0);

    // And live: temporarily demote every current row to v2, then confirm the
    // canonical selector reports nothing current. Restored immediately.
    const { data: before } = await admin
      .from('ii_capital_gains_computations')
      .select('id, engine_version')
      .eq('user_id', ground.user.userId)
      .eq('engine_version', V3_ENGINE);
    const ids = (before ?? []).map((r) => r.id as string);
    expect(ids.length).toBeGreaterThan(0);
    await admin.from('ii_capital_gains_computations').update({ engine_version: V2_ENGINE }).in('id', ids);

    const { rows, supersededCount } = await loadCurrentCapitalGainsComputations(admin, ground.user.userId);
    expect(rows, 'no current computation exists, so none may be returned').toHaveLength(0);
    expect(supersededCount).toBeGreaterThan(0);

    await admin.from('ii_capital_gains_computations').update({ engine_version: V3_ENGINE }).in('id', ids);
    const { rows: restored } = await loadCurrentCapitalGainsComputations(admin, ground.user.userId);
    expect(restored.length, 'restore must return the fixture to its current state').toBe(ids.length);
    evidence.noCurrentComputation = { demotedRows: ids.length, currentRowsWhileDemoted: 0 };
  }, 180_000);
});

// ===========================================================================
// Phase 3 — Tax Intelligence + R10 (dispatch §12, §13)
// ===========================================================================
describe('F2 Phase 3 — live-recomputing consumers', () => {
  it('F2-T07 — Tax Intelligence recomputes and returns the v3 answer, never the persisted v2 row', async () => {
    const r = await runV3(ground.user);
    expect(r.engineVersion).toBe(V3_ENGINE);
    const total = r.disposalResults.reduce((s, d) => s + (d.taxableGain ?? 0), 0);
    expect(total).toBeCloseTo(22_000, 2);
    expect(r.disposalResults.every((d) => d.gainType === 'stcg')).toBe(true);
    evidence.taxIntelligence = { engineVersion: r.engineVersion, totalTaxableGain: total, gainTypes: r.disposalResults.map((d) => d.gainType) };
  }, 180_000);

  it('F2-T08 — a NEWLY generated R10 tax chapter carries the v3 figures', async () => {
    const { loadTaxForReport } = await import('@/lib/services/investmentIntelligenceReportData');
    const taxForReport = await loadTaxForReport(ground.user.userId, ground.user.client);
    expect(taxForReport, 'the report tax section must be available').not.toBeNull();
    expect(taxForReport!.results.engineVersion, 'the report must snapshot the CURRENT engine').toBe(V3_ENGINE);
    const total = taxForReport!.results.disposalResults.reduce((s, d) => s + (d.taxableGain ?? 0), 0);
    expect(total, 'the report must carry the v3 gain, not the v2 gain').toBeCloseTo(22_000, 2);
    expect(taxForReport!.results.disposalResults.every((d) => d.gainType === 'stcg')).toBe(true);
    evidence.r10Report = { engineVersion: taxForReport!.results.engineVersion, totalTaxableGain: total };
  }, 180_000);

  it('F2-T05 — a historical as-of request stays historical and is not silently replaced by today\'s answer', async () => {
    const { loadTaxDataset } = await import('@/lib/services/investment-intelligence/taxRepository');
    const { runTaxSimulation } = await import('@/lib/engines/investment-intelligence/tax/taxOrchestrator');
    // As of 30-Jun-2025 no redemption had happened yet.
    const { dataset } = await loadTaxDataset(ground.user.client, ground.user.userId, { asOfDate: '2025-06-30' });
    expect(dataset).not.toBeNull();
    expect(dataset!.asOfDate).toBe('2025-06-30');
    const historical = runTaxSimulation({
      acquisitions: [...dataset!.acquisitionsByInstrument.values()].flat(),
      disposals: [...dataset!.disposalsByInstrument.values()].flat(),
      classificationByInstrument: dataset!.classificationByInstrument,
      fmv31Jan2018ByInstrument: dataset!.fmv31Jan2018ByInstrument,
      salePricePerUnitByDisposal: dataset!.salePricePerUnitByDisposal,
      exitLoadSchedules: dataset!.exitLoadSchedules,
      residencyProfile: {},
    });
    // The engine is still v3 — currentness of ENGINE and currentness of DATA
    // are different axes (dispatch §8).
    expect(historical.engineVersion).toBe(V3_ENGINE);
    evidence.historicalAsOf = { asOfDate: dataset!.asOfDate, engineVersion: historical.engineVersion };
  }, 180_000);
});

// ===========================================================================
// Phase 4 — security (dispatch §25)
// ===========================================================================
describe('F2 Phase 4 — cross-user isolation over the mixed table', () => {
  it('F2-T11 — a second real user cannot read either the v2 or the v3 rows of the first', async () => {
    const other = await makeUser('intruder');
    for (const table of ['ii_capital_gains_computations', 'ii_tax_lot_consumptions', 'ii_tax_lots']) {
      const { data } = await other.client.from(table).select('id, user_id').eq('user_id', ground.user.userId);
      expect(data ?? [], `user B read ${table} rows belonging to user A`).toHaveLength(0);
    }
    const { data: items } = await other.client.from('ii_review_items').select('id').eq('user_id', ground.user.userId);
    expect(items ?? [], 'user B read user A review items').toHaveLength(0);

    // Ground truth: the rows really do exist (so the empty reads above are
    // RLS working, not an empty table).
    const { count } = await admin.from('ii_capital_gains_computations').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId);
    expect(count ?? 0).toBeGreaterThan(0);
    evidence.security = { ownerRowCount: count, intruderVisibleRows: 0 };
  }, 180_000);
});


// ===========================================================================
// Phase 5 — SAME-ENGINE-VERSION staleness (dispatch §23)
//
// Engine version and data freshness are different axes. A late-arriving
// statement adds a legitimate BACKDATED acquisition into Folio B, which
// changes which lots the SAME redemption consumes — under the SAME v3
// engine. This asks whether an engine-version filter alone would be enough,
// or whether the orphan problem is more general.
// ===========================================================================
describe('F2 Phase 5 — a new backdated transaction re-matches FIFO under the same engine', () => {
  it('F2-T04 — after a legitimate new transaction, superseded SAME-VERSION rows must not remain current', async () => {
    const { persistTaxLots, persistTaxLotConsumptions, persistCapitalGainsComputations, deterministicLotId } =
      await import('@/lib/services/investment-intelligence/taxRepository');
    const { runReviewCentreRefresh } = await import('@/lib/services/investment-intelligence/reviewCentreData');

    // Which lots are current BEFORE the new transaction?
    const beforeRun = await runV3(ground.user);
    const beforeLotIds = new Set(beforeRun.disposalResults.map((d) => deterministicLotId(d.lotId)));

    // A late-arriving statement books a BACKDATED Folio B purchase, earlier
    // than the 10-Oct-2024 lot. Cloned from a real parsed row so every
    // column matches canonical shape.
    const { data: template } = await admin
      .from('ii_transactions')
      .select('*')
      .eq('user_id', ground.user.userId)
      .eq('account_id', ground.accountB)
      .eq('transaction_type', 'purchase')
      .limit(1)
      .single();
    const backdated = { ...(template as Record<string, unknown>) };
    delete backdated.id;
    delete backdated.created_at;
    backdated.transaction_date = '2024-09-01';
    backdated.source_reference = 'F2B-BACKDATED-1'; // distinct: uidx_ii_transactions_dedup
    backdated.transaction_fingerprint = createHash('sha256').update(`${RUN_TAG}-backdated`).digest('hex'); // distinct: uidx_ii_transactions_fingerprint
    backdated.units = 60;
    backdated.price_per_unit = 150;
    backdated.gross_amount = 9000;
    const { data: inserted, error: insErr } = await admin.from('ii_transactions').insert(backdated).select('id').single();
    expect(insErr, `backdated txn insert: ${insErr?.message}`).toBeNull();
    const backdatedTxnId = inserted!.id as string;

    // Recompute + persist through the REAL path.
    const afterRun = await runV3(ground.user);
    await persistTaxLots(ground.user.userId, afterRun.lots);
    await persistTaxLotConsumptions(ground.user.userId, afterRun.disposalResults);
    await persistCapitalGainsComputations(ground.user.userId, afterRun.disposalResults, afterRun.exitLoadResults);

    const afterLotIds = new Set(afterRun.disposalResults.map((d) => deterministicLotId(d.lotId)));
    expect(afterLotIds.has(deterministicLotId(`lot:${backdatedTxnId}`)), 'the backdated lot is now consumed first').toBe(true);

    // Any lot that WAS consumed and no longer is, is now a same-version orphan.
    const sameVersionOrphanLots = [...beforeLotIds].filter((l) => !afterLotIds.has(l));

    const { data: persisted } = await admin
      .from('ii_capital_gains_computations')
      .select('lot_id, engine_version, taxable_gain, exit_load_pct')
      .eq('user_id', ground.user.userId);
    const v3Persisted = (persisted ?? []).filter((r) => r.engine_version === V3_ENGINE);
    const orphanRowsAtV3 = v3Persisted.filter((r) => sameVersionOrphanLots.includes(r.lot_id as string));

    const refresh = await runReviewCentreRefresh(ground.user.userId);
    expect(refresh.error).toBeNull();
    const { data: items } = await admin
      .from('ii_review_items')
      .select('category, status, source_record_id, source_record_version')
      .eq('user_id', ground.user.userId)
      .eq('source_module', 'ii_r6_tax')
      .eq('status', 'open');
    const itemsFromSameVersionOrphans = (items ?? []).filter((i) => sameVersionOrphanLots.includes(i.source_record_id as string));

    evidence.sameVersionStaleness = {
      lotsConsumedBefore: [...beforeLotIds],
      lotsConsumedAfter: [...afterLotIds],
      sameVersionOrphanLots,
      orphanRowsStillPersistedAtCurrentEngineVersion: orphanRowsAtV3.length,
      reviewItemsDerivedFromSameVersionOrphans: itemsFromSameVersionOrphans.length,
    };

    expect(
      itemsFromSameVersionOrphans.length,
      `Review Centre surfaced ${itemsFromSameVersionOrphans.length} item(s) from SAME-VERSION superseded rows — an engine_version filter alone would not be sufficient.`
    ).toBe(0);
  }, 300_000);
});
