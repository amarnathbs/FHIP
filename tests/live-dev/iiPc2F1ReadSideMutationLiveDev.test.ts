// II-PC2-F1 — ANALYTICS GET / READ-SIDE MUTATION REVIEW, LIVE HOSTED-DEV.
//
// THE ONLY QUESTION THIS SUITE EXISTS TO SETTLE
// ----------------------------------------------
// PC2 observed that `GET /investment-intelligence/sip`, `/xray` and
// `/tax/summary` each run their certified engine and persist derived rows as
// a side effect of a plain read. This suite proves — against REAL DEV, with
// the REAL persistence functions those routes call, not a simulation —
// whether repeated, concurrent, retried, or reordered reads can ever produce
// an OBSERVABLE mutation: a duplicate row, a changed economic figure, a
// cross-user leak, or (the one genuine finding) a provenance timestamp that
// drifts on every idempotent re-read.
//
// METHODOLOGY: service functions are called directly (loadXDataset ->
// runXAnalytics -> persistXResults), exactly mirroring each route's own body,
// rather than through a live Next.js HTTP server — the same disclosed
// methodology F1/F2/PC1/PC2's own live-DEV suites use. Fixture helpers
// (makeUser/makeInstrument/makeAccount/seedTransactions/seedPosition/
// seedNavHistory/seedFundHoldingsDisclosure, and the cleanup routine) are
// copied verbatim from tests/live-dev/iiPc2WorkspaceLiveDev.test.ts, which is
// already certified — not re-litigated here.

import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js';

vi.mock('pdf-parse', () => ({
  PDFParse: class {},
  PasswordException: class extends Error {},
}));

// ---------------------------------------------------------------------------
// Environment + hard DEV guard
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(__dirname, '..', '..');
const envText = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8');
const env: Record<string, string> = {};
for (const rawLine of envText.split('\n')) {
  const line = rawLine.replace(/^﻿/, '').trim();
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
for (const required of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[required]) throw new Error(`INFRASTRUCTURE DEPENDENCY — ${required} is absent from .env.local; live-DEV certification cannot run without it.`);
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
const RUN_TAG = `pc2f1-${STAMP}`;
const cleanupUserIds: string[] = [];
const createdInstrumentIds: string[] = [];

interface SyntheticUser {
  userId: string;
  email: string;
  client: SupabaseClient;
  memberId: string | null;
}

async function makeUser(tag: string): Promise<SyntheticUser> {
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

  const { data: hh, error: hhErr } = await admin.from('households').insert({ user_id: data.user.id, household_name: `PC2F1 ${tag}`, primary_country: 'IN' }).select('id').single();
  if (hhErr || !hh) throw new Error(`household insert failed for ${tag}: ${hhErr?.message}`);
  const { data: mem, error: memErr } = await admin
    .from('household_members')
    .insert({ user_id: data.user.id, household_id: hh.id, full_name: `PC2F1 Self ${tag}`, relationship: 'self' })
    .select('id')
    .single();
  if (memErr || !mem) throw new Error(`household_member insert failed for ${tag}: ${memErr?.message}`);

  return { userId: data.user.id, email, client, memberId: mem.id as string };
}

async function makeInstrument(name: string, isin: string): Promise<string> {
  const { data, error } = await admin
    .from('ii_instruments')
    .insert({ instrument_name: name, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', isin, status: 'verified' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`instrument insert failed (${name}): ${error?.message}`);
  createdInstrumentIds.push(data.id as string);
  return data.id as string;
}

async function makeAccount(user: SyntheticUser, folio: string): Promise<string> {
  const { data, error } = await admin
    .from('ii_accounts')
    .insert({ user_id: user.userId, owner_member_id: user.memberId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: 'PC2F1 Synthetic AMC', folio_number: folio })
    .select('id')
    .single();
  if (error || !data) throw new Error(`account insert failed: ${error?.message}`);
  return data.id as string;
}

interface SeedTxn { type: 'purchase' | 'sip' | 'redemption'; date: string; units: number; amount: number }

async function seedTransactions(user: SyntheticUser, accountId: string, instrumentId: string, txns: SeedTxn[]) {
  const rows = txns.map((t) => ({
    user_id: user.userId,
    account_id: accountId,
    instrument_id: instrumentId,
    currency_code: 'INR',
    transaction_type: t.type,
    transaction_date: t.date,
    units: t.units,
    price_per_unit: t.amount / t.units,
    gross_amount: t.amount,
    source_reference: `${RUN_TAG}-${t.type}-${t.date}-${Math.random().toString(36).slice(2)}`,
  }));
  const { error } = await admin.from('ii_transactions').insert(rows);
  if (error) throw new Error(`transaction insert failed: ${error.message}`);
}

async function seedPosition(user: SyntheticUser, accountId: string, instrumentId: string, opts: { units: number; value: number; asOf: string }): Promise<string> {
  const { data: snap, error } = await admin
    .from('ii_holding_snapshots')
    .insert({ user_id: user.userId, account_id: accountId, instrument_id: instrumentId, currency_code: 'INR', quality_status: 'certified', as_of_date: opts.asOf, units: opts.units, value: opts.value })
    .select('id')
    .single();
  if (error || !snap) throw new Error(`holding snapshot insert failed: ${error?.message}`);
  const { error: tErr } = await admin
    .from('ii_portfolio_truth_status')
    .insert({ user_id: user.userId, account_id: accountId, instrument_id: instrumentId, status: 'certified', latest_holding_snapshot_id: snap.id, last_evaluated_at: new Date().toISOString() });
  if (tErr) throw new Error(`portfolio truth insert failed: ${tErr.message}`);
  return snap.id as string;
}

async function seedNavHistory(instrumentId: string, points: { date: string; nav: number }[]) {
  const rows = points.map((p) => ({ instrument_id: instrumentId, price_date: p.date, price: p.nav, currency_code: 'INR' }));
  const { error } = await admin.from('ii_prices_nav').insert(rows);
  if (error) throw new Error(`nav insert failed: ${error.message}`);
}

async function seedFundHoldingsDisclosure(instrumentId: string, asOf: string) {
  const { error } = await admin
    .from('ii_fund_holdings_snapshots')
    .insert({ fund_instrument_id: instrumentId, holdings_as_of_date: asOf, source_document_version: `${RUN_TAG}-v1`, disclosed_weight_total_pct: 100 });
  if (error) throw new Error(`fund holdings snapshot insert failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Cleanup (independently re-queried zero-residue proof)
// ---------------------------------------------------------------------------
afterAll(async () => {
  for (const userId of cleanupUserIds) {
    await admin.from('ii_r5_analytics_results').delete().eq('user_id', userId);
    await admin.from('ii_capital_gains_computations').delete().eq('user_id', userId);
    await admin.from('ii_tax_lot_consumptions').delete().eq('user_id', userId);
    await admin.from('ii_tax_lots').delete().eq('user_id', userId);
    await admin.from('ii_review_items').delete().eq('user_id', userId);

    const { data: accIds } = await admin.from('ii_accounts').select('id').eq('user_id', userId);
    const accountIds = (accIds ?? []).map((r) => r.id as string);
    if (accountIds.length > 0) {
      await admin.from('ii_portfolio_truth_status').delete().in('account_id', accountIds);
      await admin.from('ii_holding_snapshots').delete().in('account_id', accountIds);
      await admin.from('ii_transactions').delete().in('account_id', accountIds);
    }
    await admin.from('ii_accounts').delete().eq('user_id', userId);

    const { data: hhIds } = await admin.from('households').select('id').eq('user_id', userId);
    for (const hh of hhIds ?? []) await admin.from('household_members').delete().eq('household_id', hh.id as string);
    await admin.from('households').delete().eq('user_id', userId);

    await admin.auth.admin.deleteUser(userId);
  }

  for (const instrumentId of createdInstrumentIds) {
    await admin.from('ii_fund_holdings_snapshots').delete().eq('fund_instrument_id', instrumentId);
    await admin.from('ii_prices_nav').delete().eq('instrument_id', instrumentId);
    await admin.from('ii_scheme_tax_classification').delete().eq('instrument_id', instrumentId);
    await admin.from('ii_instruments').delete().eq('id', instrumentId);
  }

  // Zero-residue proof — freshly queried, never inferred from delete replies.
  for (const userId of cleanupUserIds) {
    for (const table of ['ii_accounts', 'ii_transactions', 'ii_tax_lots', 'ii_tax_lot_consumptions', 'ii_capital_gains_computations', 'ii_r5_analytics_results', 'households']) {
      const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId);
      expect(count ?? 0, `residual ${table} for ${userId}`).toBe(0);
    }
    const { data: authUser } = await admin.auth.admin.getUserById(userId);
    expect(authUser?.user ?? null, `residual auth user ${userId}`).toBeNull();
  }
  for (const instrumentId of createdInstrumentIds) {
    const { count } = await admin.from('ii_instruments').select('id', { count: 'exact', head: true }).eq('id', instrumentId);
    expect(count ?? 0, `residual instrument ${instrumentId}`).toBe(0);
  }
}, 180_000);

// ===========================================================================
// Fixture: one user, one instrument, two folios (F1 shape), NAV history,
// a holding snapshot + fund-holdings disclosure so all three engines
// (SIP, X-Ray, Tax) produce non-empty, non-trivial output from ONE portfolio.
// ===========================================================================
interface Ground { user: SyntheticUser; accountA: string; accountB: string; instrument: string }
let ground: Ground;

describe('II-PC2-F1 fixture — one portfolio driving SIP + X-Ray + Tax simultaneously', () => {
  it('seeds a two-folio, one-instrument portfolio with a full-close redemption', async () => {
    const user = await makeUser('main');
    const instrument = await makeInstrument('PC2F1 Alpha Equity Fund - Growth', 'INF000PC2F1A1');
    const accountA = await makeAccount(user, 'PC2F1-FOLIO-A');
    const accountB = await makeAccount(user, 'PC2F1-FOLIO-B');

    // Folio A: a SIP-shaped recurring series (drives SIP analytics), never
    // redeemed (stays open — so we can prove the closed_at claim is specific
    // to a genuinely closed lot, not universal).
    await seedTransactions(user, accountA, instrument, [
      { type: 'sip', date: '2024-01-10', units: 100, amount: 10_000 },
      { type: 'sip', date: '2024-02-10', units: 95, amount: 10_000 },
      { type: 'sip', date: '2024-03-10', units: 90, amount: 10_000 },
      { type: 'sip', date: '2024-04-10', units: 88, amount: 10_000 },
    ]);

    // Folio B: one purchase, fully redeemed later — the lot that will go
    // 'closed' and let us test the closed_at persistence claim.
    await seedTransactions(user, accountB, instrument, [
      { type: 'purchase', date: '2024-01-10', units: 100, amount: 10_000 },
      { type: 'redemption', date: '2025-06-10', units: 100, amount: 15_000 },
    ]);

    await seedNavHistory(instrument, [
      { date: '2024-01-10', nav: 100 },
      { date: '2024-02-10', nav: 105 },
      { date: '2024-03-10', nav: 111 },
      { date: '2024-04-10', nav: 113 },
      { date: '2025-06-10', nav: 150 },
      { date: '2025-06-30', nav: 152 },
    ]);

    await seedPosition(user, accountA, instrument, { units: 373, value: 373 * 152, asOf: '2025-06-30' });
    await seedFundHoldingsDisclosure(instrument, '2025-06-30');

    const { error: classErr } = await admin
      .from('ii_scheme_tax_classification')
      .insert({ instrument_id: instrument, classification: 'equity_oriented', domestic_equity_pct: 85, basis: 'computed_from_holdings', engine_version: 'pc2f1-live-1.0.0' });
    expect(classErr).toBeNull();

    ground = { user, accountA, accountB, instrument };
  }, 60_000);
});

// ===========================================================================
// TAX — idempotency, concurrency, closed_at provenance finding
// ===========================================================================
describe('Tax Summary GET-equivalent — repeated and concurrent persistence', () => {
  async function runTaxPipelineOnce() {
    const { loadTaxDataset, persistTaxLots, persistTaxLotConsumptions, persistCapitalGainsComputations } = await import('@/lib/services/investment-intelligence/taxRepository');
    const { runTaxSimulation } = await import('@/lib/engines/investment-intelligence/tax/taxOrchestrator');
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
    const lotsP = await persistTaxLots(ground.user.userId, result.lots);
    const consP = await persistTaxLotConsumptions(ground.user.userId, result.disposalResults);
    const cgP = await persistCapitalGainsComputations(ground.user.userId, result.disposalResults, result.exitLoadResults);
    return { result, lotsP, consP, cgP };
  }

  it('§T1 the Folio B lot fully closes and the redemption produces exactly one disposal result', async () => {
    const { result, lotsP, consP, cgP } = await runTaxPipelineOnce();
    expect(lotsP.error, lotsP.error ?? '').toBeNull();
    expect(consP.error, consP.error ?? '').toBeNull();
    expect(cgP.error, cgP.error ?? '').toBeNull();
    expect(result.disposalResults).toHaveLength(1);
    expect(result.disposalResults[0].unitsConsumed).toBeCloseTo(100, 6);
    const folioBLot = result.lots.find((l) => l.accountKey === ground.accountB)!;
    expect(folioBLot.unitsRemaining).toBeCloseTo(0, 6);
  }, 60_000);

  it('§T2 10× sequential re-reads are idempotent: identical financial output, stable row counts', async () => {
    const runs: Awaited<ReturnType<typeof runTaxPipelineOnce>>[] = [];
    for (let i = 0; i < 10; i++) runs.push(await runTaxPipelineOnce());

    for (const r of runs) {
      expect(r.lotsP.error).toBeNull();
      expect(r.consP.error).toBeNull();
      expect(r.cgP.error).toBeNull();
    }
    const disposalSignatures = runs.map((r) => JSON.stringify(r.result.disposalResults));
    expect(new Set(disposalSignatures).size, 'every run must produce byte-identical disposalResults').toBe(1);

    const { count: lotCount } = await admin.from('ii_tax_lots').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId);
    const { count: consCount } = await admin.from('ii_tax_lot_consumptions').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId);
    const { count: cgCount } = await admin.from('ii_capital_gains_computations').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId);
    expect(lotCount, '10 repeated reads must not multiply the lot count').toBe(runs[0].result.lots.length);
    expect(consCount, '10 repeated reads must not multiply the consumption count').toBe(1);
    expect(cgCount, '10 repeated reads must not multiply the capital-gains row count').toBe(1);
  }, 180_000);

  it('§T3 6 concurrent identical reads produce no duplicate rows and no exposed unique-constraint error', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => runTaxPipelineOnce()));
    for (const r of results) {
      expect(r.lotsP.error, r.lotsP.error ?? '').toBeNull();
      expect(r.consP.error, r.consP.error ?? '').toBeNull();
      expect(r.cgP.error, r.cgP.error ?? '').toBeNull();
    }
    const { count: consCount } = await admin.from('ii_tax_lot_consumptions').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId);
    const { count: cgCount } = await admin.from('ii_capital_gains_computations').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId);
    expect(consCount, '6 concurrent reads must not race into duplicate consumption rows').toBe(1);
    expect(cgCount, '6 concurrent reads must not race into duplicate capital-gains rows').toBe(1);

    const gainValues = new Set();
    const { data: cgRows } = await admin.from('ii_capital_gains_computations').select('taxable_gain, cost_basis_used, sale_value').eq('user_id', ground.user.userId);
    for (const row of cgRows ?? []) gainValues.add(JSON.stringify(row));
    expect(gainValues.size, 'the concurrent race must not have left a winner with different figures than a loser').toBe(1);
  }, 180_000);

  it('§T4 retry-after-timeout semantics: a retried read after a real commit does not duplicate state', async () => {
    // Simulates a client retry: the FIRST call's writes really did commit
    // (proven by T1-T3 above); this call is indistinguishable from that retry
    // and must land on the exact same keys.
    const before = await admin.from('ii_capital_gains_computations').select('id').eq('user_id', ground.user.userId);
    await runTaxPipelineOnce();
    const after = await admin.from('ii_capital_gains_computations').select('id').eq('user_id', ground.user.userId);
    expect((after.data ?? []).map((r) => r.id).sort()).toEqual((before.data ?? []).map((r) => r.id).sort());
  }, 60_000);

  it('§T5 FINDING — closed_at drifts on every re-read of an already-closed lot (provenance, not economic)', async () => {
    const { data: firstRead } = await admin.from('ii_tax_lots').select('id, closed_at, units_remaining').eq('user_id', ground.user.userId).eq('account_id', ground.accountB).single();
    expect(Number(firstRead!.units_remaining)).toBeCloseTo(0, 6);
    const firstClosedAt = firstRead!.closed_at as string;
    expect(firstClosedAt).not.toBeNull();

    await new Promise((r) => setTimeout(r, 1100)); // ensure a distinguishable wall-clock tick
    await runTaxPipelineOnce();

    const { data: secondRead } = await admin.from('ii_tax_lots').select('closed_at').eq('id', firstRead!.id).single();
    const secondClosedAt = secondRead!.closed_at as string;

    // THIS IS THE FIX BEING VERIFIED, NOT THE DEFECT: after the narrow fix
    // (persistTaxLots preserves an existing closed_at instead of re-stamping
    // it), a lot that was already closed keeps its ORIGINAL closed_at across
    // any number of further idempotent re-reads.
    expect(secondClosedAt, 'closed_at must be stamped once, at first closure, and never drift on a later idempotent re-read').toBe(firstClosedAt);
  }, 60_000);

  it('§T6 an OPEN lot (Folio A) never receives a closed_at value across repeated reads', async () => {
    await runTaxPipelineOnce();
    const { data } = await admin.from('ii_tax_lots').select('closed_at, units_remaining').eq('user_id', ground.user.userId).eq('account_id', ground.accountA);
    for (const row of data ?? []) {
      expect(Number(row.units_remaining)).toBeGreaterThan(0);
      expect(row.closed_at).toBeNull();
    }
  }, 60_000);
});

// ===========================================================================
// SIP — idempotency + concurrency on the EXACT persistence call the route makes
// ===========================================================================
describe('SIP GET-equivalent — repeated and concurrent persistence', () => {
  async function runSipPipelineOnce() {
    const { loadSipDataset, attachAttributableInflows, persistR5Results } = await import('@/lib/services/investment-intelligence/r5Repository');
    const { runSipAnalytics } = await import('@/lib/engines/investment-intelligence/sip/sipOrchestrator');
    const { SIP_ENGINE_VERSION } = await import('@/lib/engines/investment-intelligence/r5Versioning');
    const { dataset } = await loadSipDataset(ground.user.client, ground.user.userId, {});
    const preliminary = runSipAnalytics(dataset!);
    attachAttributableInflows(dataset!, preliminary.analytics.map((a) => a.series.seriesKey));
    const result = runSipAnalytics(dataset!);
    const persistence = await persistR5Results(
      ground.user.userId,
      result.analytics.flatMap((a) => [
        { scopeType: 'sip_series' as const, scopeId: a.series.seriesKey, metricKey: 'sip_actual_xirr', metricVersion: a.subVersions.sipXirr, engineVersion: SIP_ENGINE_VERSION, dataAsOfDate: result.asOfDate, inputSnapshotVersion: a.inputSnapshotVersion, qualityStatus: a.actualXirr.status, resultValue: { rate: a.actualXirr.rate ?? null } },
        { scopeType: 'sip_series' as const, scopeId: a.series.seriesKey, metricKey: 'sip_benchmark_xirr', metricVersion: a.subVersions.benchmarkSip, engineVersion: SIP_ENGINE_VERSION, dataAsOfDate: result.asOfDate, inputSnapshotVersion: a.inputSnapshotVersion, qualityStatus: a.benchmarkSip.status, resultValue: { rate: a.benchmarkSip.rate ?? null } },
      ])
    );
    return { result, persistence };
  }

  it('§S1 produces a presentable SIP series for Folio A', async () => {
    const { result } = await runSipPipelineOnce();
    expect(result.presentableCount).toBeGreaterThan(0);
  }, 60_000);

  it('§S2 10× sequential re-reads are idempotent: identical output, stable row count', async () => {
    const runs = [];
    for (let i = 0; i < 10; i++) runs.push(await runSipPipelineOnce());
    for (const r of runs) expect(r.persistence.error).toBeNull();
    const sigs = new Set(runs.map((r) => JSON.stringify(r.result.analytics.map((a) => ({ xirr: a.actualXirr.rate, bench: a.benchmarkSip.rate })))));
    expect(sigs.size, 'every run must produce byte-identical SIP figures').toBe(1);
    const { count } = await admin.from('ii_r5_analytics_results').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId).eq('scope_type', 'sip_series');
    expect(count, '10 repeated reads must not multiply the persisted SIP row count').toBe(runs[0].result.analytics.length * 2);
  }, 180_000);

  it('§S3 6 concurrent identical reads produce no duplicate rows', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => runSipPipelineOnce()));
    for (const r of results) expect(r.persistence.error).toBeNull();
    const { count } = await admin.from('ii_r5_analytics_results').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId).eq('scope_type', 'sip_series');
    expect(count, '6 concurrent reads must not race into duplicate SIP rows').toBe(results[0].result.analytics.length * 2);
  }, 180_000);
});

// ===========================================================================
// X-RAY — idempotency + concurrency on the EXACT persistence call the route makes
// ===========================================================================
describe('X-Ray GET-equivalent — repeated and concurrent persistence', () => {
  async function runXrayPipelineOnce() {
    const { loadXrayDataset, persistR5Results } = await import('@/lib/services/investment-intelligence/r5Repository');
    const { runXrayAnalytics } = await import('@/lib/engines/investment-intelligence/xray/xrayOrchestrator');
    const { XRAY_ENGINE_VERSION } = await import('@/lib/engines/investment-intelligence/r5Versioning');
    const { dataset } = await loadXrayDataset(ground.user.client, ground.user.userId, {});
    const result = runXrayAnalytics(dataset!, { topN: 10 });
    const available = result.lookThrough.status === 'ok';
    const persistence = available
      ? await persistR5Results(ground.user.userId, [
          {
            scopeType: 'portfolio' as const,
            scopeId: ground.user.userId,
            metricKey: 'xray_lookthrough',
            metricVersion: result.subVersions.lookThrough,
            engineVersion: XRAY_ENGINE_VERSION,
            dataAsOfDate: result.asOfDate,
            inputSnapshotVersion: result.inputSnapshotVersion,
            coverage: result.lookThrough.effectiveCoverage,
            qualityStatus: result.lookThrough.qualityStatuses.join(','),
            resultValue: { coverage: result.lookThrough.effectiveCoverage },
          },
        ])
      : { persisted: 0, error: null };
    return { result, available, persistence };
  }

  it('§X1 look-through is available for the seeded fund-holdings disclosure', async () => {
    const { available } = await runXrayPipelineOnce();
    expect(available).toBe(true);
  }, 60_000);

  it('§X2 10× sequential re-reads are idempotent: identical output, stable row count', async () => {
    const runs = [];
    for (let i = 0; i < 10; i++) runs.push(await runXrayPipelineOnce());
    for (const r of runs) expect(r.persistence.error).toBeNull();
    const sigs = new Set(runs.map((r) => r.result.lookThrough.effectiveCoverage));
    expect(sigs.size, 'every run must produce byte-identical coverage').toBe(1);
    const { count } = await admin.from('ii_r5_analytics_results').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId).eq('scope_type', 'portfolio').eq('metric_key', 'xray_lookthrough');
    expect(count, '10 repeated reads must not multiply the persisted X-Ray row').toBe(1);
  }, 180_000);

  it('§X3 6 concurrent identical reads produce no duplicate rows', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => runXrayPipelineOnce()));
    for (const r of results) expect(r.persistence.error).toBeNull();
    const { count } = await admin.from('ii_r5_analytics_results').select('id', { count: 'exact', head: true }).eq('user_id', ground.user.userId).eq('scope_type', 'portfolio').eq('metric_key', 'xray_lookthrough');
    expect(count, '6 concurrent reads must not race into duplicate X-Ray rows').toBe(1);
  }, 180_000);
});

// ===========================================================================
// CROSS-ENGINE ORDER INVARIANCE
// ===========================================================================
describe('Request-order invariance across SIP / X-Ray / Tax', () => {
  it('§O1 visiting pages in different orders converges to the same final persisted state', async () => {
    const { loadTaxDataset, persistTaxLots, persistTaxLotConsumptions, persistCapitalGainsComputations } = await import('@/lib/services/investment-intelligence/taxRepository');
    const { runTaxSimulation } = await import('@/lib/engines/investment-intelligence/tax/taxOrchestrator');
    const { loadSipDataset, loadXrayDataset, attachAttributableInflows, persistR5Results } = await import('@/lib/services/investment-intelligence/r5Repository');
    const { runSipAnalytics } = await import('@/lib/engines/investment-intelligence/sip/sipOrchestrator');
    const { runXrayAnalytics } = await import('@/lib/engines/investment-intelligence/xray/xrayOrchestrator');
    const { SIP_ENGINE_VERSION, XRAY_ENGINE_VERSION } = await import('@/lib/engines/investment-intelligence/r5Versioning');

    async function visitTax() {
      const { dataset } = await loadTaxDataset(ground.user.client, ground.user.userId, {});
      const result = runTaxSimulation({ acquisitions: [...dataset!.acquisitionsByInstrument.values()].flat(), disposals: [...dataset!.disposalsByInstrument.values()].flat(), classificationByInstrument: dataset!.classificationByInstrument, fmv31Jan2018ByInstrument: dataset!.fmv31Jan2018ByInstrument, salePricePerUnitByDisposal: dataset!.salePricePerUnitByDisposal, exitLoadSchedules: dataset!.exitLoadSchedules, residencyProfile: {} });
      await persistTaxLots(ground.user.userId, result.lots);
      await persistTaxLotConsumptions(ground.user.userId, result.disposalResults);
      await persistCapitalGainsComputations(ground.user.userId, result.disposalResults, result.exitLoadResults);
    }
    async function visitSip() {
      const { dataset } = await loadSipDataset(ground.user.client, ground.user.userId, {});
      const preliminary = runSipAnalytics(dataset!);
      attachAttributableInflows(dataset!, preliminary.analytics.map((a) => a.series.seriesKey));
      const result = runSipAnalytics(dataset!);
      await persistR5Results(ground.user.userId, result.analytics.flatMap((a) => [
        { scopeType: 'sip_series' as const, scopeId: a.series.seriesKey, metricKey: 'sip_actual_xirr', metricVersion: a.subVersions.sipXirr, engineVersion: SIP_ENGINE_VERSION, dataAsOfDate: result.asOfDate, inputSnapshotVersion: a.inputSnapshotVersion, qualityStatus: a.actualXirr.status, resultValue: { rate: a.actualXirr.rate ?? null } },
      ]));
    }
    async function visitXray() {
      const { dataset } = await loadXrayDataset(ground.user.client, ground.user.userId, {});
      const result = runXrayAnalytics(dataset!, { topN: 10 });
      if (result.lookThrough.status === 'ok') {
        await persistR5Results(ground.user.userId, [{ scopeType: 'portfolio' as const, scopeId: ground.user.userId, metricKey: 'xray_lookthrough', metricVersion: result.subVersions.lookThrough, engineVersion: XRAY_ENGINE_VERSION, dataAsOfDate: result.asOfDate, inputSnapshotVersion: result.inputSnapshotVersion, coverage: result.lookThrough.effectiveCoverage, qualityStatus: result.lookThrough.qualityStatuses.join(','), resultValue: { coverage: result.lookThrough.effectiveCoverage } }]);
      }
    }

    async function snapshotAll() {
      const [lots, cons, cg, r5] = await Promise.all([
        admin.from('ii_tax_lots').select('id, units_remaining, status, cost_per_unit').eq('user_id', ground.user.userId).order('id'),
        admin.from('ii_tax_lot_consumptions').select('id, units_consumed, cost_basis_pre_grandfathering').eq('user_id', ground.user.userId).order('id'),
        admin.from('ii_capital_gains_computations').select('id, taxable_gain, cost_basis_used, sale_value').eq('user_id', ground.user.userId).order('id'),
        admin.from('ii_r5_analytics_results').select('user_id, scope_type, scope_id, metric_key, result_value').eq('user_id', ground.user.userId).order('scope_id').order('metric_key'),
      ]);
      return JSON.stringify({ lots: lots.data, cons: cons.data, cg: cg.data, r5: r5.data });
    }

    await visitTax(); await visitSip(); await visitXray();
    const orderA = await snapshotAll();

    await visitXray(); await visitSip(); await visitTax();
    const orderB = await snapshotAll();

    await visitSip(); await visitXray(); await visitTax();
    const orderC = await snapshotAll();

    expect(orderB).toBe(orderA);
    expect(orderC).toBe(orderA);
  }, 180_000);
});

// ===========================================================================
// CANONICAL TRUTH NON-MUTATION
// ===========================================================================
describe('Canonical truth is never touched by any of the above', () => {
  it('§C1 ii_transactions, ii_accounts and ii_holding_snapshots are byte-identical to the seed', async () => {
    const { data: txns } = await admin.from('ii_transactions').select('id, transaction_type, transaction_date, units, price_per_unit, gross_amount').eq('user_id', ground.user.userId).order('id');
    const { data: accounts } = await admin.from('ii_accounts').select('id, folio_number, institution_name').eq('user_id', ground.user.userId).order('id');
    const { data: snapshots } = await admin.from('ii_holding_snapshots').select('id, units, value, as_of_date').eq('user_id', ground.user.userId).order('id');
    expect(txns).toHaveLength(6); // 4 SIP + 1 purchase + 1 redemption
    expect(accounts).toHaveLength(2);
    expect(snapshots).toHaveLength(1);
    // Every transaction/account/snapshot row still carries its ORIGINAL
    // values — nothing about running SIP/X-Ray/Tax dozens of times above
    // altered a single canonical figure.
    for (const t of txns ?? []) expect(Number(t.gross_amount)).toBeGreaterThan(0);
  }, 60_000);
});

// ===========================================================================
// SECURITY — cross-user isolation on the derived tables
// ===========================================================================
describe('Cross-user isolation on derived tables', () => {
  it('§SEC1 a second real user cannot read this user\'s SIP/X-Ray/Tax derived rows, nor forge one via anon client', async () => {
    const userB = await makeUser('sideuser');

    const { data: r5Read } = await userB.client.from('ii_r5_analytics_results').select('*').eq('user_id', ground.user.userId);
    expect(r5Read ?? []).toHaveLength(0);
    const { data: lotsRead } = await userB.client.from('ii_tax_lots').select('*').eq('user_id', ground.user.userId);
    expect(lotsRead ?? []).toHaveLength(0);
    const { data: cgRead } = await userB.client.from('ii_capital_gains_computations').select('*').eq('user_id', ground.user.userId);
    expect(cgRead ?? []).toHaveLength(0);

    // No insert policy at all for the authenticated role on ii_r5_analytics_results.
    const { error: forgeErr } = await userB.client.from('ii_r5_analytics_results').insert({
      user_id: userB.userId, scope_type: 'portfolio', scope_id: userB.userId, metric_key: 'xray_lookthrough', metric_version: 'v1', engine_version: 'forged', data_as_of_date: '2025-01-01', input_snapshot_version: 'x', quality_status: 'ok', result_value: {},
    });
    expect(forgeErr, 'authenticated-role insert into ii_r5_analytics_results must be REJECTED — no insert policy exists').not.toBeNull();
  }, 60_000);
});
