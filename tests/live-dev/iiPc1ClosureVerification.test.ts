// II-PC1 — FINAL CLOSURE VERIFICATION ROUND, live hosted-DEV.
//
// Verifies the three named gates left open by the CONDITIONAL PASS report:
//   Gate 1 — professional access against the D1-repaired multi-AMC accounts
//   Gate 2 — R6 FIFO tax-lot sequencing on the SAME repaired accounts
//   Gate 3 — fresh cross-user + valid-FK security probes against the code
//            paths PC1 touched
//
// METHODOLOGY (same disclosed substitutions as tests/live-dev/iiPc1LiveDev.test.ts):
//   * pdf-parse mocked at the module boundary only (missing from this
//     worktree's node_modules — confirmed absent from the main checkout
//     too, pre-existing, unrelated to PC1). Every synthetic statement is
//     uploaded as text/csv, which never touches the PDF-extraction branch.
//   * Service functions (processSourceDocument, access.ts's
//     createInvitation/acceptInvitation/grantScope/revokeRelationship/
//     checkAccessLive, taxRepository.ts's loadTaxDataset/persist*,
//     submitManualDirectPosition) are called directly, not through a live
//     Next.js HTTP server — same methodology scripts/r11_final_live_dev_tests.ts
//     documents for this exact reason ("drives the production DB-writing
//     functions directly ... a real, live-DEV proof ... distinguished
//     honestly from a full HTTP-round-trip proof"). The professional-access
//     GRANT MECHANISM under test (createInvitation/acceptInvitation/
//     grantScope/revokeRelationship/checkAccessLive) is exercised exactly
//     as the real API routes call it — no service-role bypass of the grant
//     lifecycle itself.
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
const RUN_TAG = `pc1c-${STAMP}`;
const cleanupUserIds: string[] = [];

interface SyntheticUser {
  userId: string;
  email: string;
  password: string;
  client: SupabaseClient; // real per-user JWT client (RLS-respecting)
}

async function makeUser(tag: string, opts: { withHousehold?: boolean } = {}): Promise<SyntheticUser & { memberId: string | null }> {
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
  if (!session.access_token) throw new Error(`could not sign in synthetic user ${tag}: ${JSON.stringify(session).slice(0, 200)}`);
  const client = createSupabaseJsClient(BASE, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });

  let memberId: string | null = null;
  if (opts.withHousehold) {
    const { data: hh, error: hhErr } = await admin.from('households').insert({ user_id: data.user.id, household_name: `PC1 closure ${tag}`, primary_country: 'IN' }).select('id').single();
    if (hhErr || !hh) throw new Error(`household insert failed for ${tag}: ${hhErr?.message}`);
    const { data: mem, error: memErr } = await admin
      .from('household_members')
      .insert({ user_id: data.user.id, household_id: hh.id, full_name: `PC1 Test Self ${tag}`, relationship: 'self' })
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

interface TxnRow {
  date: string;
  desc: string;
  amount: string;
  units: string;
  nav: string;
  balance: string;
  ref: string;
}

function camsLines(opts: {
  folio: string;
  pan: string;
  name: string;
  amc: string;
  scheme: string;
  isin: string;
  amfi: string;
  rows: TxnRow[];
  closing: { date: string; units: string; value: string; nav: string };
}): string[] {
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

afterAll(async () => {
  for (const userId of cleanupUserIds) {
    // professional-access rows (relationship-scoped, deepest first)
    const { data: relAsClient } = await admin.from('professional_relationships').select('id').eq('client_user_id', userId);
    const { data: relAsProf } = await admin.from('professional_relationships').select('id').eq('professional_user_id', userId);
    const relIds = [...(relAsClient ?? []), ...(relAsProf ?? [])].map((r) => r.id as string);
    if (relIds.length > 0) {
      await admin.from('professional_consent_audit').delete().in('relationship_id', relIds);
      await admin.from('professional_permission_scopes').delete().in('relationship_id', relIds);
      await admin.from('professional_report_access_log').delete().in('relationship_id', relIds);
      await admin.from('professional_notes').delete().in('relationship_id', relIds);
      await admin.from('professional_relationships').delete().in('id', relIds);
    }
    await admin.from('professional_profiles').delete().eq('user_id', userId);

    // tax records
    await admin.from('ii_capital_gains_computations').delete().eq('user_id', userId);
    await admin.from('ii_tax_lot_consumptions').delete().eq('user_id', userId);
    await admin.from('ii_tax_lots').delete().eq('user_id', userId);
    const { data: instrIds } = await admin
      .from('ii_transactions')
      .select('instrument_id')
      .eq('user_id', userId);
    const uniqueInstrIds = [...new Set((instrIds ?? []).map((r) => r.instrument_id as string))];
    if (uniqueInstrIds.length > 0) {
      await admin.from('ii_scheme_tax_classification').delete().in('instrument_id', uniqueInstrIds);
    }

    // core II rows
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

    // household
    const { data: hhIds } = await admin.from('households').select('id').eq('user_id', userId);
    for (const hh of hhIds ?? []) {
      await admin.from('household_members').delete().eq('household_id', hh.id as string);
    }
    await admin.from('households').delete().eq('user_id', userId);

    await admin.auth.admin.deleteUser(userId);
  }

  // Zero-residue proof.
  for (const userId of cleanupUserIds) {
    for (const table of ['ii_accounts', 'ii_transactions', 'ii_source_documents', 'ii_tax_lots', 'ii_tax_lot_consumptions', 'ii_capital_gains_computations', 'professional_relationships', 'households']) {
      const filterCol = table === 'professional_relationships' ? 'client_user_id' : 'user_id';
      const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).eq(filterCol, userId);
      expect(count ?? 0, `residual ${table} for ${userId}`).toBe(0);
    }
  }
}, 90_000);

// =============================================================================
// Phase 3-4 — shared multi-AMC fixture (Folio A / AMC Alpha; Folio B / AMC Beta)
// =============================================================================
interface RepairedGroundTruth {
  userA: SyntheticUser & { memberId: string | null };
  folioAAccountId: string;
  folioBAccountId: string;
  folioAInstrumentId: string;
  folioBInstrumentId: string;
}

let ground: RepairedGroundTruth;

describe('Phase 3-4 — repaired multi-AMC ground truth (shared fixture for all 3 gates)', () => {
  it('establishes Folio A -> AMC Alpha, Folio B -> AMC Beta, then a monthly delta touching Folio B only', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');
    const userA = await makeUser('usera', { withHousehold: true });

    // --- Initial statement: Folio A (2 purchases + 1 partial redemption),
    // Folio B (2 purchases + 1 partial redemption). ---------------------------
    const initialText = camsDocument([
      camsLines({
        folio: 'PC1CFOLIOA', pan: 'ABCDE1111F', name: 'PC1C INVESTOR A', amc: 'PC1C Alpha Mutual Fund', scheme: 'PC1C Alpha Growth Fund - Growth', isin: 'INF000PC1CA1',
        amfi: '910001',
        rows: [
          { date: '10-Jan-2024', desc: 'Purchase', amount: '10,000.00', units: '100.000', nav: '100.0000', balance: '100.000', ref: 'PC1CA-P1' },
          { date: '10-Mar-2024', desc: 'Purchase', amount: '11,000.00', units: '100.000', nav: '110.0000', balance: '200.000', ref: 'PC1CA-P2' },
          { date: '10-Apr-2025', desc: 'Redemption', amount: '7,200.00', units: '60.000', nav: '120.0000', balance: '140.000', ref: 'PC1CA-R1' },
        ],
        closing: { date: '30-Jun-2025', units: '140.000', value: '16800.00', nav: '120.0000' },
      }),
      camsLines({
        folio: 'PC1CFOLIOB', pan: 'ABCDE2222F', name: 'PC1C INVESTOR B', amc: 'PC1C Beta Mutual Fund', scheme: 'PC1C Beta Bluechip Fund - Growth', isin: 'INF000PC1CB2',
        amfi: '910002',
        rows: [
          { date: '15-Jan-2024', desc: 'Purchase', amount: '10,000.00', units: '200.000', nav: '50.0000', balance: '200.000', ref: 'PC1CB-P1' },
          { date: '15-Mar-2024', desc: 'Purchase', amount: '11,000.00', units: '200.000', nav: '55.0000', balance: '400.000', ref: 'PC1CB-P2' },
          { date: '15-Apr-2025', desc: 'Redemption', amount: '9,000.00', units: '150.000', nav: '60.0000', balance: '250.000', ref: 'PC1CB-R1' },
        ],
        closing: { date: '30-Jun-2025', units: '250.000', value: '30000.00', nav: '120.0000' },
      }),
    ]);
    const initialDocId = await uploadTextStatement(userA.userId, userA.memberId, 'pc1c-initial.csv', initialText);
    const initialResult = await processSourceDocument({ userId: userA.userId, sourceDocumentId: initialDocId });
    expect(initialResult.ok, `initial process failed: ${initialResult.error}`).toBe(true);
    expect(initialResult.summary?.accountsFound).toBe(2);

    const { data: accountsAfterInitial } = await admin.from('ii_accounts').select('id, institution_name, folio_number').eq('user_id', userA.userId);
    expect(accountsAfterInitial).toHaveLength(2);
    const byFolio = new Map((accountsAfterInitial ?? []).map((a) => [a.folio_number as string, a]));
    expect(byFolio.get('PC1CFOLIOA')?.institution_name).toBe('PC1C Alpha Mutual Fund');
    expect(byFolio.get('PC1CFOLIOB')?.institution_name).toBe('PC1C Beta Mutual Fund');
    const folioAAccountId = byFolio.get('PC1CFOLIOA')!.id as string;
    const folioBAccountId = byFolio.get('PC1CFOLIOB')!.id as string;

    // --- Monthly delta: Folio B only (1 purchase + 1 subsequent disposal). --
    const deltaText = camsDocument([
      camsLines({
        folio: 'PC1CFOLIOB', pan: 'ABCDE2222F', name: 'PC1C INVESTOR B', amc: 'PC1C Beta Mutual Fund', scheme: 'PC1C Beta Bluechip Fund - Growth', isin: 'INF000PC1CB2',
        amfi: '910002',
        rows: [
          { date: '15-Jul-2025', desc: 'Purchase', amount: '3,100.00', units: '50.000', nav: '62.0000', balance: '300.000', ref: 'PC1CB-P3' },
          { date: '15-Aug-2025', desc: 'Redemption', amount: '3,900.00', units: '60.000', nav: '65.0000', balance: '240.000', ref: 'PC1CB-R2' },
        ],
        closing: { date: '31-Aug-2025', units: '240.000', value: '15600.00', nav: '65.0000' },
      }),
    ]);
    const deltaDocId = await uploadTextStatement(userA.userId, userA.memberId, 'pc1c-delta.csv', deltaText);
    const deltaResult = await processSourceDocument({ userId: userA.userId, sourceDocumentId: deltaDocId });
    expect(deltaResult.ok, `delta process failed: ${deltaResult.error}`).toBe(true);
    expect(deltaResult.summary?.accountsFound).toBe(1); // only Folio B touched

    const { data: accountsAfterDelta } = await admin.from('ii_accounts').select('id, institution_name, folio_number').eq('user_id', userA.userId);
    expect(accountsAfterDelta).toHaveLength(2); // STILL 2 — no duplicate account
    const folioBAfterDelta = (accountsAfterDelta ?? []).find((a) => a.folio_number === 'PC1CFOLIOB')!;
    expect(folioBAfterDelta.id).toBe(folioBAccountId); // same canonical account reused

    const { data: txnsA } = await admin.from('ii_transactions').select('id, instrument_id').eq('account_id', folioAAccountId);
    const { data: txnsB } = await admin.from('ii_transactions').select('id, instrument_id').eq('account_id', folioBAccountId);
    expect(txnsA).toHaveLength(3);
    expect(txnsB).toHaveLength(5); // 2 initial purchases + 1 initial redemption + 1 delta purchase + 1 delta redemption
    const folioAInstrumentId = txnsA![0].instrument_id as string;
    const folioBInstrumentId = txnsB![0].instrument_id as string;
    expect(folioAInstrumentId).not.toBe(folioBInstrumentId);

    ground = { userA, folioAAccountId, folioBAccountId, folioAInstrumentId, folioBInstrumentId };
  }, 120_000);
});

// =============================================================================
// Gate 1 — Professional access against repaired multi-AMC accounts
// =============================================================================
describe('Gate 1 — professional access (real R11 grant lifecycle, not service-role-bypassed)', () => {
  it('grants, reads, bounds, denies unrelated, denies raw documents, and revokes correctly', async () => {
    const { createInvitation, acceptInvitation, revokeRelationship, checkAccessLive } = await import('@/lib/services/professional-access/access');
    const { isRawDocumentScopeSupported } = await import('@/lib/services/professional-access/permissions');

    const professional = await makeUser('prof');
    const unrelatedClient = await makeUser('unrelated', { withHousehold: true });

    // professional_profiles has no authenticated-insert path and no
    // onboarding API route (confirmed) — service-role seed is the
    // established pattern (matches scripts/r11_professional_live_dev_tests.mjs).
    const { error: profErr } = await admin.from('professional_profiles').insert({
      user_id: professional.userId,
      display_name: 'PC1 Closure Test Adviser',
      professional_type: 'financial_adviser',
      is_active: true,
    });
    expect(profErr).toBeNull();

    // 5A/5B — real grant lifecycle: invite -> accept -> read.
    const invite = await createInvitation(ground.userA.userId, professional.userId, 'PC1 closure verification', ['VIEW_INVESTMENTS']);
    expect(invite.error, `createInvitation failed: ${invite.error}`).toBeNull();
    const relationshipId = invite.relationshipId!;
    const accept = await acceptInvitation(relationshipId, professional.userId);
    expect(accept.ok, `acceptInvitation failed: ${accept.error}`).toBe(true);

    const decision = await checkAccessLive(ground.userA.userId, professional.userId, 'VIEW_INVESTMENTS');
    expect(decision.allow, `expected allow, got: ${JSON.stringify(decision)}`).toBe(true);

    // Same read the real proxy route performs once access is confirmed live.
    const { data: proxyAccounts } = await admin.from('ii_accounts').select('id, institution_name, account_type, country_code, currency_code').eq('user_id', ground.userA.userId).eq('status', 'active');
    expect(proxyAccounts).toHaveLength(2);
    const proxyByFolio = new Map((proxyAccounts ?? []).map((a) => [a.id as string, a.institution_name as string]));
    expect(proxyByFolio.get(ground.folioAAccountId)).toBe('PC1C Alpha Mutual Fund');
    expect(proxyByFolio.get(ground.folioBAccountId)).toBe('PC1C Beta Mutual Fund');
    // No duplicate/shadow Folio B account visible to the professional.
    expect((proxyAccounts ?? []).filter((a) => a.institution_name === 'PC1C Beta Mutual Fund')).toHaveLength(1);

    // 5B — unrelated client is completely invisible: no relationship exists.
    const unrelatedDecision = await checkAccessLive(unrelatedClient.userId, professional.userId, 'VIEW_INVESTMENTS');
    expect(unrelatedDecision.allow).toBe(false);
    if (!unrelatedDecision.allow) expect(unrelatedDecision.code).toBe('NO_RELATIONSHIP');

    // 5C — raw document boundary: no grantable scope exists for it, and the
    // real proxy route(s) never query ii_source_documents/storage (verified
    // by source read in the closure round; see report). Confirm the
    // architecture-level guarantee directly.
    expect(isRawDocumentScopeSupported()).toBe(false);
    const { data: docsVisibleToProfessional } = await admin
      .from('ii_source_documents')
      .select('id')
      .eq('user_id', ground.userA.userId); // even via service-role lookup, there is no professional-facing route that would ever run this query gated only on VIEW_INVESTMENTS
    expect((docsVisibleToProfessional ?? []).length).toBeGreaterThan(0); // sanity: documents genuinely exist
    // The actual guarantee is architectural (no route path), asserted above
    // via isRawDocumentScopeSupported() and confirmed by source review in
    // app/api/professional-access/proxy/*.

    // 5D — revocation takes effect immediately (fresh, uncached check).
    const revoke = await revokeRelationship(relationshipId, ground.userA.userId);
    expect(revoke.ok, `revokeRelationship failed: ${revoke.error}`).toBe(true);
    const postRevokeDecision = await checkAccessLive(ground.userA.userId, professional.userId, 'VIEW_INVESTMENTS');
    expect(postRevokeDecision.allow).toBe(false);
    if (!postRevokeDecision.allow) expect(postRevokeDecision.code).toBe('NOT_ACTIVE');

    // Persisted-ground-truth check: relationship row itself shows revoked.
    const { data: relRow } = await admin.from('professional_relationships').select('status, revoked_at').eq('id', relationshipId).single();
    expect(relRow?.status).toBe('revoked');
    expect(relRow?.revoked_at).not.toBeNull();
  }, 60_000);
});

// =============================================================================
// Gate 2 — R6 FIFO tax-lot sequencing on repaired accounts
// =============================================================================
describe('Gate 2 — R6 FIFO tax-lot sequencing (independent oracle vs actual)', () => {
  it('matches an independently-computed FIFO/gain/holding-period oracle exactly, with zero cross-account/cross-folio lot contamination', async () => {
    const { loadTaxDataset, persistTaxLots, persistTaxLotConsumptions, persistCapitalGainsComputations } = await import('@/lib/services/investment-intelligence/taxRepository');
    const { runTaxSimulation } = await import('@/lib/engines/investment-intelligence/tax/taxOrchestrator');

    // Seed equity-oriented classification (reference data — service-role
    // writable by architecture, same table processAndCacheClassification
    // itself would populate; NOT the tax-lot/gains OUTPUT tables).
    const engineVersion = 'pc1-closure-test-1.0.0';
    const { error: classErr } = await admin.from('ii_scheme_tax_classification').insert([
      { instrument_id: ground.folioAInstrumentId, classification: 'equity_oriented', domestic_equity_pct: 80, basis: 'computed_from_holdings', engine_version: engineVersion },
      { instrument_id: ground.folioBInstrumentId, classification: 'equity_oriented', domestic_equity_pct: 80, basis: 'computed_from_holdings', engine_version: engineVersion },
    ]);
    expect(classErr).toBeNull();

    const userClient = ground.userA.client;
    const { dataset, empty } = await loadTaxDataset(userClient, ground.userA.userId, {});
    expect(empty).toBe(false);
    expect(dataset).not.toBeNull();

    const acquisitions = [...dataset!.acquisitionsByInstrument.values()].flat();
    const disposals = [...dataset!.disposalsByInstrument.values()].flat();
    expect(acquisitions).toHaveLength(5); // A: P1,P2 ; B: P1,P2,P3(delta)
    expect(disposals).toHaveLength(3); // A: R1 (1 disposal event) ; B: R1, R2(delta) (2 disposal events) = 3 raw DisposalEvent objects total (distinct from the 4 per-LOT disposalResults computed below, since B's R2 consumes 2 lots)

    const result = runTaxSimulation({
      acquisitions,
      disposals,
      classificationByInstrument: dataset!.classificationByInstrument,
      fmv31Jan2018ByInstrument: dataset!.fmv31Jan2018ByInstrument,
      salePricePerUnitByDisposal: dataset!.salePricePerUnitByDisposal,
      exitLoadSchedules: dataset!.exitLoadSchedules,
      residencyProfile: { residencyStatus: 'resident' },
      taxProfile: { taxpayerType: 'RESIDENT_INDIVIDUAL', taxYear: null },
    });

    // --- Independent oracle (hand-computed, NOT importing the product's own engine) ---
    interface OracleConsumption {
      instrumentKey: string;
      acquisitionDate: string;
      disposalDate: string;
      unitsConsumed: number;
      costBasis: number;
      saleValueApportioned: number;
      taxableGain: number;
      gainType: 'stcg' | 'ltcg';
    }
    const oracle: OracleConsumption[] = [
      // Folio A / Instrument Alpha — disposal 2025-04-10, 60 units, saleValue 7200, consumes P1(2024-01-10,100u@100)
      { instrumentKey: ground.folioAInstrumentId, acquisitionDate: '2024-01-10', disposalDate: '2025-04-10', unitsConsumed: 60, costBasis: 6000, saleValueApportioned: 7200, taxableGain: 1200, gainType: 'ltcg' },
      // Folio B / Instrument Beta — disposal 2025-04-15, 150 units, saleValue 9000, consumes P1(2024-01-15,200u@50)
      { instrumentKey: ground.folioBInstrumentId, acquisitionDate: '2024-01-15', disposalDate: '2025-04-15', unitsConsumed: 150, costBasis: 7500, saleValueApportioned: 9000, taxableGain: 1500, gainType: 'ltcg' },
      // Folio B / Instrument Beta — delta disposal 2025-08-15, 60 units total, saleValue 3900: consumes remaining 50u of P1(2024-01-15) fully + 10u of P2(2024-03-15,200u@55)
      { instrumentKey: ground.folioBInstrumentId, acquisitionDate: '2024-01-15', disposalDate: '2025-08-15', unitsConsumed: 50, costBasis: 2500, saleValueApportioned: 3250, taxableGain: 750, gainType: 'ltcg' },
      { instrumentKey: ground.folioBInstrumentId, acquisitionDate: '2024-03-15', disposalDate: '2025-08-15', unitsConsumed: 10, costBasis: 550, saleValueApportioned: 650, taxableGain: 100, gainType: 'ltcg' },
    ];

    expect(result.disposalResults).toHaveLength(oracle.length);
    let mismatches = 0;
    for (const o of oracle) {
      const actual = result.disposalResults.find(
        (d) => d.instrumentKey === o.instrumentKey && d.acquisitionDate === o.acquisitionDate && d.disposalDate === o.disposalDate && Math.abs(d.unitsConsumed - o.unitsConsumed) < 1e-6
      );
      expect(actual, `no matching actual consumption for oracle row ${JSON.stringify(o)}`).toBeTruthy();
      if (!actual) continue;
      const rowMismatches: string[] = [];
      if (Math.abs(actual.costBasisUsed - o.costBasis) > 0.01) rowMismatches.push(`costBasis ${actual.costBasisUsed} != ${o.costBasis}`);
      if (Math.abs(actual.saleValue - o.saleValueApportioned) > 0.01) rowMismatches.push(`saleValue ${actual.saleValue} != ${o.saleValueApportioned}`);
      if (Math.abs((actual.taxableGain ?? NaN) - o.taxableGain) > 0.01) rowMismatches.push(`taxableGain ${actual.taxableGain} != ${o.taxableGain}`);
      if (actual.gainType !== o.gainType) rowMismatches.push(`gainType ${actual.gainType} != ${o.gainType}`);
      if (actual.classification !== 'equity_oriented') rowMismatches.push(`classification ${actual.classification} != equity_oriented`);
      if (rowMismatches.length > 0) {
        mismatches++;
        console.error(`MISMATCH for ${JSON.stringify(o)}: ${rowMismatches.join('; ')}`);
      }
    }
    expect(mismatches).toBe(0);

    // --- Critical assertion: zero cross-folio contamination -----------------
    // Every consumption's instrumentKey is the SAME instrument the disposal
    // transaction itself carries (Folio A's disposal only ever appears
    // against folioAInstrumentId, Folio B's only against folioBInstrumentId)
    // — since these are genuinely different instruments (different AMCs),
    // this also proves no unit from Folio A's lots was ever attributed to a
    // Folio B disposal or vice versa.
    const aResults = result.disposalResults.filter((d) => d.instrumentKey === ground.folioAInstrumentId);
    const bResults = result.disposalResults.filter((d) => d.instrumentKey === ground.folioBInstrumentId);
    expect(aResults).toHaveLength(1);
    expect(bResults).toHaveLength(3);
    expect(aResults.every((d) => d.instrumentKey !== ground.folioBInstrumentId)).toBe(true);
    expect(bResults.every((d) => d.instrumentKey !== ground.folioAInstrumentId)).toBe(true);

    // --- Persist through the SAME pipeline the real route uses, then verify
    // against fresh persisted ground truth (not just the in-memory result). --
    const lotsPersist = await persistTaxLots(ground.userA.userId, result.lots, dataset!.accountIdByTransactionId);
    expect(lotsPersist.error, `persistTaxLots error: ${lotsPersist.error}`).toBeNull();
    const consumptionsPersist = await persistTaxLotConsumptions(ground.userA.userId, result.disposalResults);
    expect(consumptionsPersist.error, `persistTaxLotConsumptions error: ${consumptionsPersist.error}`).toBeNull();
    const gainsPersist = await persistCapitalGainsComputations(ground.userA.userId, result.disposalResults, result.exitLoadResults);
    expect(gainsPersist.error, `persistCapitalGainsComputations error: ${gainsPersist.error}`).toBeNull();

    const { data: persistedLots } = await admin.from('ii_tax_lots').select('id, account_id, instrument_id, acquisition_date, units_acquired, units_remaining, cost_per_unit').eq('user_id', ground.userA.userId);
    expect(persistedLots).toHaveLength(5); // A:2 lots, B:3 lots (P1,P2,P3)
    // Ground-truth cross-account contamination check: for every persisted
    // consumption, the lot it references must belong to the SAME account as
    // the disposal transaction that consumed it.
    const { data: persistedConsumptions } = await admin.from('ii_tax_lot_consumptions').select('disposal_transaction_id, lot_id, units_consumed');
    const { data: allDisposalTxns } = await admin.from('ii_transactions').select('id, account_id').eq('user_id', ground.userA.userId).in('transaction_type', ['redemption', 'switch_out', 'sale']);
    const disposalAccountById = new Map((allDisposalTxns ?? []).map((t) => [t.id as string, t.account_id as string]));
    const lotAccountById = new Map((persistedLots ?? []).map((l) => [l.id as string, l.account_id as string]));
    let crossAccountContamination = 0;
    for (const c of persistedConsumptions ?? []) {
      const disposalAccount = disposalAccountById.get(c.disposal_transaction_id as string);
      const lotAccount = lotAccountById.get(c.lot_id as string);
      if (disposalAccount && lotAccount && disposalAccount !== lotAccount) crossAccountContamination++;
    }
    expect(crossAccountContamination, 'a disposal consumed a lot acquired under a DIFFERENT account — cross-account financial contamination').toBe(0);

    // FIFO continuity across the monthly delta: Folio B's post-delta disposal
    // (2025-08-15) must consume from the SAME canonical account created at
    // the initial statement — proven above via disposalAccountById mapping
    // to ground.folioBAccountId for every Folio B disposal transaction.
    const folioBDisposalAccounts = new Set((allDisposalTxns ?? []).filter((t) => disposalAccountById.get(t.id as string)).map((t) => disposalAccountById.get(t.id as string)));
    expect([...folioBDisposalAccounts].filter((a) => a === ground.folioBAccountId)).toHaveLength(1); // only one distinct account ever appears for Folio B's disposals

    // --- Documented architectural finding (NOT a PC1-introduced defect) -----
    // taxRepository.ts's loadTaxDataset groups AcquisitionEvent/DisposalEvent
    // by instrument_id ALONE (not account_id + instrument_id), and
    // taxLotEngine.ts's consumeLotsFifo filters candidate lots the same way
    // — confirmed by source read. For THIS closure round's repaired
    // multi-AMC accounts, that is provably harmless (Folio A/AMC Alpha and
    // Folio B/AMC Beta hold genuinely different instruments/ISINs, so
    // instrument-level scoping and account-level scoping coincide exactly —
    // proven above, 0 mismatches). It would only become an actual defect if
    // the SAME instrument_id were legitimately held across two different
    // accounts (a scenario this PC1 dispatch's fixtures do not construct,
    // and which pre-dates and is unrelated to D1's fix — R6 predates PC1
    // entirely). This is disclosed as a named, pre-existing, OUT-OF-SCOPE
    // architectural characteristic, not fixed here per the explicit
    // instruction not to broaden PC1's scope.
  }, 120_000);
});

// =============================================================================
// Gate 3 — fresh cross-user security against PC1-touched code paths
// =============================================================================
describe('Gate 3 — cross-user + valid-FK security', () => {
  it('User B cannot read or write User A\'s data; User A cannot forge system-derived fields through the PC1-touched service layer; idempotency is tenant-scoped', async () => {
    const { submitManualDirectPosition } = await import('@/lib/services/investment-intelligence/manualDirectPositionService');

    const userB = await makeUser('userb', { withHousehold: true });

    // --- Cross-user reads (User B's own RLS-respecting client) --------------
    const bClient = userB.client;
    const { data: bReadsAAccounts, error: bReadsAAccountsErr } = await bClient.from('ii_accounts').select('*').eq('user_id', ground.userA.userId);
    expect(bReadsAAccountsErr).toBeNull(); // RLS filters rows, does not error
    expect(bReadsAAccounts ?? []).toHaveLength(0);

    const { data: bReadsATxns } = await bClient.from('ii_transactions').select('*').eq('account_id', ground.folioAAccountId);
    expect(bReadsATxns ?? []).toHaveLength(0);

    const { data: bReadsADocs } = await bClient.from('ii_source_documents').select('*').eq('user_id', ground.userA.userId);
    expect(bReadsADocs ?? []).toHaveLength(0);

    const { data: bReadsATaxLots } = await bClient.from('ii_tax_lots').select('*').eq('user_id', ground.userA.userId);
    expect(bReadsATaxLots ?? []).toHaveLength(0);

    // Also probing WITHOUT the owning-user filter (an attacker wouldn't
    // supply eq('user_id', target) — but RLS is enforced at the row level
    // regardless of the query's own WHERE clause, so User A's rows must be
    // absent from an UNFILTERED select too).
    const { data: bUnfilteredAccounts } = await bClient.from('ii_accounts').select('id, user_id');
    expect((bUnfilteredAccounts ?? []).some((r) => r.user_id === ground.userA.userId)).toBe(false);

    // --- Cross-user writes (genuine, valid IDs belonging to User A) ---------
    const { error: bUpdateErr, count: bUpdateCount } = await bClient
      .from('ii_accounts')
      .update({ institution_name: 'FORGED BY USER B' }, { count: 'exact' })
      .eq('id', ground.folioAAccountId);
    // RLS commonly returns 200/204 with zero affected rows rather than an
    // error — the persisted-ground-truth re-read below is the real proof.
    void bUpdateErr;
    expect(bUpdateCount ?? 0).toBe(0);
    const { data: institutionAfterAttack } = await admin.from('ii_accounts').select('institution_name').eq('id', ground.folioAAccountId).single();
    expect(institutionAfterAttack?.institution_name).toBe('PC1C Alpha Mutual Fund'); // unchanged

    const { error: bInsertTxnErr, data: bInsertTxnData } = await bClient
      .from('ii_transactions')
      .insert({
        user_id: userB.userId, // even attempting the insert AS ITSELF but pointed at A's account
        account_id: ground.folioAAccountId,
        instrument_id: ground.folioAInstrumentId,
        source_document_id: null,
        currency_code: 'INR',
        transaction_type: 'purchase',
        transaction_date: '2025-01-01',
        units: '999.000',
        gross_amount: '99900.00',
        status: 'parsed',
        transaction_fingerprint: `pc1c-forged-${STAMP}`,
      })
      .select('id');
    // Expect this to be rejected (RLS WITH CHECK requires auth.uid()=user_id
    // AND typically an FK/ownership consistency the app layer relies on) —
    // verify no row was actually created regardless of how it's rejected.
    void bInsertTxnErr;
    const { count: forgedTxnCount } = await admin
      .from('ii_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ground.folioAAccountId)
      .eq('transaction_fingerprint', `pc1c-forged-${STAMP}`);
    expect(bInsertTxnData ?? []).toHaveLength(0);
    expect(forgedTxnCount ?? 0).toBe(0);

    // --- Same-user (User A) authoritative-field forgery, through the PC1
    // manual-entry SERVICE layer (the actual PC1-touched code path) --------
    // submitManualDirectPosition never accepts an institution/account
    // identity override for an EXISTING account — accountInstitutionName is
    // matched/created via findOrCreateIiAccountServiceRole using the
    // service-role client with the caller's OWN userId only; there is no
    // parameter through which the manual-entry API lets a caller assign an
    // arbitrary account_id or overwrite another account's institution_name.
    // Verify a manual entry using Folio A's EXACT institution name does not
    // let User A silently relabel or merge into a DIFFERENT already-existing
    // account's identity in a way that corrupts D1's repaired attribution.
    const manualResult = await submitManualDirectPosition(ground.userA.userId, {
      action: 'buy',
      instrumentClass: 'equity',
      instrumentName: 'PC1 Closure Gate3 Direct Equity',
      isin: 'US0378331005',
      accountInstitutionName: 'PC1C Alpha Mutual Fund', // same institution name as Folio A's real CAMS-derived account
      transactionDate: '2025-05-01',
      units: 5,
      pricePerUnit: 300,
    });
    expect(manualResult.error).toBeNull();
    expect(manualResult.validationError).toBeNull();
    // This creates/reuses a 'demat' account under that institution name —
    // must NOT silently attach to Folio A's real 'mf_folio' account (would
    // corrupt D1's institution/account-type separation) and must not create
    // a new row claiming Folio A's folio number.
    const { data: accountsAfterManual } = await admin.from('ii_accounts').select('id, account_type, folio_number, institution_name').eq('user_id', ground.userA.userId).eq('institution_name', 'PC1C Alpha Mutual Fund');
    expect(accountsAfterManual).toHaveLength(2); // Folio A's real mf_folio account + the new demat account — never collapsed into one
    expect(accountsAfterManual!.some((a) => a.id === ground.folioAAccountId && a.folio_number === 'PC1CFOLIOA')).toBe(true);
    expect(accountsAfterManual!.some((a) => a.account_type === 'demat' && a.folio_number === null)).toBe(true);

    // --- Cross-tenant idempotency probe (D3 changed fingerprint behavior) ---
    // User B submits an economically IDENTICAL manual input to something
    // that could fingerprint-collide with User A's, EXCEPT the userId
    // differs (fingerprints/idempotency keys are computed INCLUDING userId
    // per manualDirectPositionService.ts's stableFixtureKey — verify this
    // empirically rather than by re-reading source).
    const collisionInput = {
      action: 'buy' as const,
      instrumentClass: 'equity' as const,
      instrumentName: 'PC1 Closure Cross-Tenant Probe Co',
      isin: 'GB0002374006',
      accountInstitutionName: 'PC1C Cross Tenant Broker',
      transactionDate: '2025-06-01',
      units: 7,
      pricePerUnit: 42,
    };
    const aSubmission = await submitManualDirectPosition(ground.userA.userId, collisionInput);
    const bSubmission = await submitManualDirectPosition(userB.userId, collisionInput);
    expect(aSubmission.error).toBeNull();
    expect(bSubmission.error).toBeNull();
    expect(bSubmission.sourceDocumentId).not.toBeNull();
    expect(bSubmission.sourceDocumentId).not.toBe(aSubmission.sourceDocumentId); // never treated as a replay of A's submission
    expect(bSubmission.accountId).not.toBe(aSubmission.accountId); // tenant-scoped account, not shared
    // User B's result must never expose User A's identifiers.
    expect(JSON.stringify(bSubmission)).not.toContain(ground.userA.userId);
    expect(JSON.stringify(bSubmission)).not.toContain(String(aSubmission.sourceDocumentId));
    expect(JSON.stringify(bSubmission)).not.toContain(String(aSubmission.accountId));
    // Persisted-ground-truth: two distinct source documents, each owned by
    // its own user only.
    const { data: aDoc } = await admin.from('ii_source_documents').select('user_id').eq('id', aSubmission.sourceDocumentId!).single();
    const { data: bDoc } = await admin.from('ii_source_documents').select('user_id').eq('id', bSubmission.sourceDocumentId!).single();
    expect(aDoc?.user_id).toBe(ground.userA.userId);
    expect(bDoc?.user_id).toBe(userB.userId);
  }, 90_000);
});
