// II-PC2 — ANALYTICS FRONT-END & DISCOVERABILITY, LIVE HOSTED-DEV.
//
// WHAT THIS SUITE EXISTS TO SETTLE
// --------------------------------
// PC2 adds one new backend surface (the Overview summary) and one new claim
// per analysis ("this analysis is / is not available for your data"). Two
// things must be true against REAL data, and neither can be proven by a unit
// test over hand-made inputs:
//
//   1. The Overview's availability claim AGREES with what the real engine
//      actually produces. A card saying AVAILABLE when the certified engine
//      returns nothing is spec section 30's exact prohibition ("Never infer
//      AVAILABLE merely because route exists"), and a card saying
//      NOT_APPLICABLE when a real disposal exists would hide a tax figure.
//
//   2. The Overview leaks nothing across tenants. It is a NEW aggregation of
//      several tables at once, which is precisely the shape of surface that
//      accidentally widens disclosure (spec sections 48-49).
//
// FIXTURE PROVENANCE: the synthetic-user helper, the DEV-project guard, the
// CAMS text-fixture builders and the cleanup routine are taken from
// tests/live-dev/iiPc1F1FifoAccountScopeLiveDev.test.ts, which is already
// certified, so their behaviour is not re-litigated here.
//
// NOTE ON THE text/csv UPLOAD PATH: the certified F1/F2 live-DEV suites store
// CAMS statement TEXT with a text/csv mime so documentProcessing skips PDF
// extraction and exercises the real parser/reconciliation path without a
// binary PDF fixture. This is exactly why PC2 did NOT remove `text/csv` from
// storage.ts's ALLOWED_MIME_TYPES — that backend capability is load-bearing
// for that harness (spec section 15 forbids removing backend capability
// another path genuinely uses). Only the misleading USER-FACING claim was
// corrected.
//
// This suite seeds canonical rows directly through the service-role client
// rather than re-parsing statements: PC2 adds no ingestion behaviour, and
// F1/F2 already certify the parse path. What PC2 must prove is that the
// Overview's availability verdicts match reality for a range of real portfolio
// shapes, which is what the eight scenarios below do.

import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildOverviewSummary } from '@/lib/services/investment-intelligence/overviewSummary';
import { buildAnalysisCards, nextStep } from '@/lib/investment-intelligence/analysisAvailability';
import { II_WORKSPACE_NAV } from '@/lib/investment-intelligence/workspaceNav';

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
  // Each line is normalised BEFORE matching, because the .env.local on this
  // machine is CRLF-terminated and carries a UTF-8 BOM. A stricter
  // `/^([A-Z_]+)=(.*)$/` against the raw line silently parses NOTHING: `.`
  // does not match the trailing `\r` and `$` (no `m` flag) will not match
  // before it, so every key comes back undefined and the only symptom is a
  // downstream "supabaseUrl is required" / "Invalid URL". Several existing
  // tests/unit/resources*.test.ts suites fail on exactly this today.
  const line = rawLine.replace(/^﻿/, '').trim();
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
for (const required of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[required]) {
    throw new Error(`INFRASTRUCTURE DEPENDENCY — ${required} is absent from .env.local; live-DEV certification cannot run without it.`);
  }
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
const RUN_TAG = `pc2-${STAMP}`;
const cleanupUserIds: string[] = [];
const createdInstrumentIds: string[] = [];

interface SyntheticUser {
  userId: string;
  email: string;
  client: SupabaseClient;
  memberId: string | null;
}

async function makeUser(tag: string, country: 'IN' | 'AU' = 'IN'): Promise<SyntheticUser> {
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

  const { data: hh, error: hhErr } = await admin
    .from('households')
    .insert({ user_id: data.user.id, household_name: `PC2 ${tag}`, primary_country: country })
    .select('id')
    .single();
  if (hhErr || !hh) throw new Error(`household insert failed for ${tag}: ${hhErr?.message}`);
  const { data: mem, error: memErr } = await admin
    .from('household_members')
    .insert({ user_id: data.user.id, household_id: hh.id, full_name: `PC2 Self ${tag}`, relationship: 'self' })
    .select('id')
    .single();
  if (memErr || !mem) throw new Error(`household_member insert failed for ${tag}: ${memErr?.message}`);

  return { userId: data.user.id, email, client, memberId: mem.id as string };
}

async function makeInstrument(name: string, instrumentClass: string, isin: string): Promise<string> {
  const { data, error } = await admin
    .from('ii_instruments')
    .insert({ instrument_name: name, instrument_class: instrumentClass, country_of_domicile: 'IN', base_currency: 'INR', isin, status: 'verified' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`instrument insert failed (${name}): ${error?.message}`);
  createdInstrumentIds.push(data.id as string);
  return data.id as string;
}

async function makeAccount(user: SyntheticUser, folio: string, currency = 'INR', country = 'IN'): Promise<string> {
  const { data, error } = await admin
    .from('ii_accounts')
    .insert({
      user_id: user.userId,
      owner_member_id: user.memberId,
      country_code: country,
      currency_code: currency,
      account_type: 'mf_folio',
      institution_name: 'PC2 Synthetic AMC',
      folio_number: folio,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`account insert failed: ${error?.message}`);
  return data.id as string;
}

interface SeedTxn {
  type: 'purchase' | 'sip' | 'redemption' | 'switch_out' | 'sale';
  date: string;
  units: number;
  amount: number;
}

async function seedTransactions(user: SyntheticUser, accountId: string, instrumentId: string, txns: SeedTxn[], currency = 'INR') {
  const rows = txns.map((t) => ({
    user_id: user.userId,
    account_id: accountId,
    instrument_id: instrumentId,
    currency_code: currency,
    transaction_type: t.type,
    transaction_date: t.date,
    units: t.units,
    price_per_unit: t.amount / t.units,
    gross_amount: t.amount,
    source_reference: `${RUN_TAG}-${t.type}-${t.date}`,
  }));
  const { error } = await admin.from('ii_transactions').insert(rows);
  if (error) throw new Error(`transaction insert failed: ${error.message}`);
}

async function seedPosition(
  user: SyntheticUser,
  accountId: string,
  instrumentId: string,
  opts: { units: number; value: number; asOf: string; currency?: string; truthStatus?: string }
): Promise<string> {
  const currency = opts.currency ?? 'INR';
  const { data: snap, error } = await admin
    .from('ii_holding_snapshots')
    .insert({
      user_id: user.userId,
      account_id: accountId,
      instrument_id: instrumentId,
      currency_code: currency,
      quality_status: 'certified',
      as_of_date: opts.asOf,
      units: opts.units,
      value: opts.value,
    })
    .select('id')
    .single();
  if (error || !snap) throw new Error(`holding snapshot insert failed: ${error?.message}`);
  const { error: tErr } = await admin.from('ii_portfolio_truth_status').insert({
    user_id: user.userId,
    account_id: accountId,
    instrument_id: instrumentId,
    status: opts.truthStatus ?? 'certified',
    latest_holding_snapshot_id: snap.id,
    last_evaluated_at: new Date().toISOString(),
  });
  if (tErr) throw new Error(`portfolio truth insert failed: ${tErr.message}`);
  return snap.id as string;
}

async function seedNavHistory(instrumentId: string, points: { date: string; nav: number }[]) {
  // The column is `price`, not `nav` — ii_prices_nav is the generic price
  // series table (it also carries listed-security prices), so the NAV of a
  // mutual fund is stored as that instrument's price on a date.
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

/** The exact RLS-scoped call the Overview route makes. */
async function overviewFor(user: SyntheticUser) {
  const summary = await buildOverviewSummary(user.client, user.userId);
  return { summary, cards: buildAnalysisCards(summary.signals), step: nextStep(summary.signals, summary.dataQuality.publishedPositionCount) };
}

const cardStatus = (cards: { key: string; status: string }[], key: string) => cards.find((c) => c.key === key)?.status;

// ---------------------------------------------------------------------------
// Cleanup (spec section 61)
// ---------------------------------------------------------------------------
afterAll(async () => {
  for (const userId of cleanupUserIds) {
    await admin.from('ii_capital_gains_computations').delete().eq('user_id', userId);
    await admin.from('ii_tax_lot_consumptions').delete().eq('user_id', userId);
    await admin.from('ii_tax_lots').delete().eq('user_id', userId);
    await admin.from('ii_review_items').delete().eq('user_id', userId);
    await admin.from('ii_fhip_publications').delete().eq('user_id', userId);
    await admin.from('ii_goal_allocations').delete().eq('user_id', userId);

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

  // Instrument-scoped reference rows this suite minted. ii_instruments is a
  // SHARED catalogue table (flagged by F1/F2 as surviving user deletion), so
  // rows this run created are removed EXPLICITLY by id — never by a blanket
  // delete that could reach real reference data.
  for (const instrumentId of createdInstrumentIds) {
    await admin.from('ii_fund_holdings_snapshots').delete().eq('fund_instrument_id', instrumentId);
    await admin.from('ii_prices_nav').delete().eq('instrument_id', instrumentId);
    await admin.from('ii_instrument_benchmarks').delete().eq('instrument_id', instrumentId);
    await admin.from('ii_scheme_tax_classification').delete().eq('instrument_id', instrumentId);
    await admin.from('ii_instruments').delete().eq('id', instrumentId);
  }

  // Zero-residue proof — freshly queried, never inferred from delete replies.
  for (const userId of cleanupUserIds) {
    for (const table of [
      'ii_accounts',
      'ii_transactions',
      'ii_source_documents',
      'ii_holding_snapshots',
      'ii_portfolio_truth_status',
      'ii_reconciliation_cases',
      'ii_tax_lots',
      'ii_capital_gains_computations',
      'ii_review_items',
      'ii_fhip_publications',
      'households',
    ]) {
      const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId);
      expect(count ?? 0, `residual ${table} for ${userId}`).toBe(0);
    }
    const { data: authUser } = await admin.auth.admin.getUserById(userId);
    expect(authUser?.user ?? null, `residual auth user ${userId}`).toBeNull();
  }
  for (const instrumentId of createdInstrumentIds) {
    const { count } = await admin.from('ii_instruments').select('id', { count: 'exact', head: true }).eq('id', instrumentId);
    expect(count ?? 0, `residual synthetic instrument ${instrumentId}`).toBe(0);
  }
}, 180_000);

// ===========================================================================
// PC2-U1 — mutual-fund rich. Maximum analytics availability expected.
// ===========================================================================
describe('PC2-U1 — mutual fund rich', () => {
  it('reports every analysis available, and agrees with the real engines', async () => {
    const user = await makeUser('u1');
    const fundA = await makeInstrument(`${RUN_TAG} Alpha Equity Fund`, 'mutual_fund', `INF${STAMP % 1000000}A1`);
    const fundB = await makeInstrument(`${RUN_TAG} Beta Equity Fund`, 'mutual_fund', `INF${STAMP % 1000000}B1`);
    const folio = await makeAccount(user, `${RUN_TAG}-F1`);

    // A genuine recurring series: 6 monthly contributions, plus a disposal.
    await seedTransactions(user, folio, fundA, [
      { type: 'sip', date: '2024-01-05', units: 100, amount: 10000 },
      { type: 'sip', date: '2024-02-05', units: 95, amount: 10000 },
      { type: 'sip', date: '2024-03-05', units: 90, amount: 10000 },
      { type: 'sip', date: '2024-04-05', units: 88, amount: 10000 },
      { type: 'sip', date: '2024-05-06', units: 85, amount: 10000 },
      { type: 'sip', date: '2024-06-05', units: 80, amount: 10000 },
      { type: 'redemption', date: '2025-02-10', units: 50, amount: 7000 },
    ]);
    await seedTransactions(user, folio, fundB, [{ type: 'purchase', date: '2024-01-20', units: 200, amount: 20000 }]);

    await seedPosition(user, folio, fundA, { units: 488, value: 68320, asOf: '2025-06-30' });
    await seedPosition(user, folio, fundB, { units: 200, value: 24000, asOf: '2025-06-30' });
    await seedNavHistory(fundA, [
      { date: '2024-01-05', nav: 100 },
      { date: '2024-06-05', nav: 125 },
      { date: '2025-06-30', nav: 140 },
    ]);
    await seedFundHoldingsDisclosure(fundA, '2025-06-30');
    await seedFundHoldingsDisclosure(fundB, '2025-06-30');

    const { summary, cards, step } = await overviewFor(user);

    // --- What do I have? (spec section 10) ---
    expect(summary.portfolio.positionCount).toBe(2);
    expect(summary.portfolio.accountCount).toBe(1);
    expect(summary.portfolio.instrumentCount).toBe(2);
    expect(summary.portfolio.instrumentClasses).toEqual(['mutual_fund']);
    expect(summary.portfolio.latestAsOfDate).toBe('2025-06-30');
    // Currency-aware: one currency here, and it is NOT blended with anything.
    expect(summary.portfolio.valueByCurrency).toHaveLength(1);
    expect(summary.portfolio.valueByCurrency[0].currencyCode).toBe('INR');
    expect(summary.portfolio.valueByCurrency[0].totalValue).toBeCloseTo(92320, 2);

    // --- Signals are real counts, not guesses ---
    expect(summary.signals.transactionCount).toBe(8);
    expect(summary.signals.contributionCount).toBe(7);
    expect(summary.signals.disposalCount).toBe(1);
    expect(summary.signals.certifiedPositionCount).toBe(2);
    expect(summary.signals.lookThroughEligibleInstrumentCount).toBe(2);
    expect(summary.signals.instrumentsWithFundHoldingsCount).toBe(2);

    // --- Maximum availability (spec section 43 PC2-U1, section 68) ---
    expect(cardStatus(cards, 'performance')).toBe('AVAILABLE');
    expect(cardStatus(cards, 'sip')).toBe('AVAILABLE');
    expect(cardStatus(cards, 'xray')).toBe('AVAILABLE');
    expect(cardStatus(cards, 'tax')).toBe('AVAILABLE');
    expect(cardStatus(cards, 'review')).toBe('AVAILABLE');
    expect(step.code).not.toBe('IMPORT_FIRST_STATEMENT');

    // --- AGREEMENT WITH THE REAL TAX ENGINE (spec sections 30, 46) ---
    // The Overview claims a disposal exists and tax is assessable. Prove the
    // certified R6 engine independently finds the same disposal — a card that
    // claims AVAILABLE while the engine returns nothing is the exact defect
    // spec section 30 forbids.
    const { loadTaxDataset } = await import('@/lib/services/investment-intelligence/taxRepository');
    const taxLoad = await loadTaxDataset(user.client, user.userId, {});
    expect(taxLoad.empty, 'R6 must find a usable dataset when the Tax card says AVAILABLE').toBe(false);
    const disposalTotal = [...(taxLoad.dataset?.disposalsByInstrument.values() ?? [])].reduce((n, arr) => n + arr.length, 0);
    expect(disposalTotal, 'engine disposal count must match the Overview signal').toBe(summary.signals.disposalCount);
  }, 180_000);
});

// ===========================================================================
// PC2-U2 — new investor / limited history.
// ===========================================================================
describe('PC2-U2 — new investor, limited history', () => {
  it('offers performance but is explicit that recurring analysis is not yet possible', async () => {
    const user = await makeUser('u2');
    const fund = await makeInstrument(`${RUN_TAG} Solo Fund`, 'mutual_fund', `INF${STAMP % 1000000}S1`);
    const folio = await makeAccount(user, `${RUN_TAG}-F2`);
    await seedTransactions(user, folio, fund, [{ type: 'purchase', date: '2025-05-01', units: 100, amount: 10000 }]);
    await seedPosition(user, folio, fund, { units: 100, value: 10500, asOf: '2025-06-30' });
    await seedNavHistory(fund, [{ date: '2025-06-30', nav: 105 }]);

    const { summary, cards } = await overviewFor(user);
    expect(summary.signals.positionCount).toBe(1);
    expect(summary.signals.contributionCount).toBe(1);

    // One contribution can never be a recurring series.
    expect(cardStatus(cards, 'sip')).toBe('NOT_ENOUGH_DATA');
    // No disposal — genuinely not applicable, not a zero gain.
    expect(cardStatus(cards, 'tax')).toBe('NOT_APPLICABLE');
    // Funds held but no disclosure ingested.
    expect(cardStatus(cards, 'xray')).toBe('REFERENCE_DATA_MISSING');
  }, 120_000);
});

// ===========================================================================
// PC2-U3 — no SIP.
// ===========================================================================
describe('PC2-U3 — no recurring contributions', () => {
  it('states the recurring-inference floor rather than showing an empty SIP block', async () => {
    const user = await makeUser('u3');
    const fund = await makeInstrument(`${RUN_TAG} NoSip Fund`, 'mutual_fund', `INF${STAMP % 1000000}N1`);
    const folio = await makeAccount(user, `${RUN_TAG}-F3`);
    // Two purchases: a coincidence, never a SIP.
    await seedTransactions(user, folio, fund, [
      { type: 'purchase', date: '2024-03-01', units: 50, amount: 5000 },
      { type: 'purchase', date: '2024-09-01', units: 40, amount: 5000 },
    ]);
    await seedPosition(user, folio, fund, { units: 90, value: 11000, asOf: '2025-06-30' });

    const { cards } = await overviewFor(user);
    const sip = cards.find((c) => c.key === 'sip')!;
    expect(sip.status).toBe('NOT_ENOUGH_DATA');
    expect(sip.detail).toMatch(/at least 3 contributions/i);
    // And it never claims "0 SIPs".
    expect(sip.detail).not.toMatch(/\b0 (recurring|SIP)/i);
  }, 120_000);
});

// ===========================================================================
// PC2-U4 — missing X-Ray reference data. NO ZERO EXPOSURE.
// ===========================================================================
describe('PC2-U4 — fund holdings disclosure unavailable', () => {
  it('reports the reference-data gap and never a zero exposure', async () => {
    const user = await makeUser('u4');
    const fund = await makeInstrument(`${RUN_TAG} Undisclosed Fund`, 'mutual_fund', `INF${STAMP % 1000000}U1`);
    const folio = await makeAccount(user, `${RUN_TAG}-F4`);
    await seedTransactions(user, folio, fund, [{ type: 'purchase', date: '2024-02-01', units: 300, amount: 30000 }]);
    await seedPosition(user, folio, fund, { units: 300, value: 33000, asOf: '2025-06-30' });
    // Deliberately NO ii_fund_holdings_snapshots row.

    const { summary, cards } = await overviewFor(user);
    expect(summary.signals.lookThroughEligibleInstrumentCount).toBe(1);
    expect(summary.signals.instrumentsWithFundHoldingsCount).toBe(0);

    const xray = cards.find((c) => c.key === 'xray')!;
    expect(xray.status).toBe('REFERENCE_DATA_MISSING');
    expect(xray.detail).toMatch(/not available for these schemes/i);
    expect(xray.detail).not.toMatch(/0\s?%/);

    // The real X-Ray engine must agree the look-through is not usable.
    const { loadXrayDataset } = await import('@/lib/services/investment-intelligence/r5Repository');
    const { runXrayAnalytics } = await import('@/lib/engines/investment-intelligence/xray/xrayOrchestrator');
    const load = await loadXrayDataset(user.client, user.userId, {});
    if (!load.empty && load.dataset) {
      const result = runXrayAnalytics(load.dataset, { topN: 10 });
      expect(result.lookThrough.status, 'engine must NOT report a usable look-through when disclosure is absent').not.toBe('ok');
    }
  }, 180_000);
});

// ===========================================================================
// PC2-U5 / PC2-U6 — disposal vs no disposal.
// ===========================================================================
describe('PC2-U5 — recorded disposal', () => {
  it('reports tax as available and the engine finds the same disposal', async () => {
    const user = await makeUser('u5');
    const fund = await makeInstrument(`${RUN_TAG} Disposal Fund`, 'mutual_fund', `INF${STAMP % 1000000}D1`);
    const folio = await makeAccount(user, `${RUN_TAG}-F5`);
    await seedTransactions(user, folio, fund, [
      { type: 'purchase', date: '2022-04-01', units: 500, amount: 50000 },
      { type: 'redemption', date: '2025-03-15', units: 200, amount: 30000 },
    ]);
    await seedPosition(user, folio, fund, { units: 300, value: 45000, asOf: '2025-06-30' });

    const { summary, cards } = await overviewFor(user);
    expect(summary.signals.disposalCount).toBe(1);
    const tax = cards.find((c) => c.key === 'tax')!;
    expect(tax.status).toBe('AVAILABLE');
    expect(tax.detail).toMatch(/1 recorded disposal\b/);

    const { loadTaxDataset } = await import('@/lib/services/investment-intelligence/taxRepository');
    const load = await loadTaxDataset(user.client, user.userId, {});
    expect(load.empty).toBe(false);
    const engineDisposals = [...(load.dataset?.disposalsByInstrument.values() ?? [])].reduce((n, a) => n + a.length, 0);
    expect(engineDisposals).toBe(1);
  }, 180_000);
});

describe('PC2-U6 — no disposal', () => {
  it('says no disposal exists rather than reporting a zero realised gain', async () => {
    const user = await makeUser('u6');
    const fund = await makeInstrument(`${RUN_TAG} HoldOnly Fund`, 'mutual_fund', `INF${STAMP % 1000000}H1`);
    const folio = await makeAccount(user, `${RUN_TAG}-F6`);
    await seedTransactions(user, folio, fund, [
      { type: 'purchase', date: '2023-04-01', units: 500, amount: 50000 },
      { type: 'sip', date: '2023-05-01', units: 100, amount: 10000 },
      { type: 'sip', date: '2023-06-01', units: 100, amount: 10000 },
    ]);
    await seedPosition(user, folio, fund, { units: 700, value: 80000, asOf: '2025-06-30' });

    const { summary, cards } = await overviewFor(user);
    expect(summary.signals.disposalCount).toBe(0);
    const tax = cards.find((c) => c.key === 'tax')!;
    expect(tax.status).toBe('NOT_APPLICABLE');
    expect(tax.detail).toMatch(/no recorded disposal/i);
    expect(tax.detail).not.toMatch(/₹\s?0|0\.00/);
  }, 120_000);
});

// ===========================================================================
// PC2-U7 — direct equity / ETF (R12).
// ===========================================================================
describe('PC2-U7 — direct equity and ETF holder', () => {
  it('does not present itself as mutual-funds-only, and is truthful about look-through', async () => {
    const user = await makeUser('u7');
    const equity = await makeInstrument(`${RUN_TAG} Direct Equity Ltd`, 'equity', `INE${STAMP % 1000000}E1`);
    const folio = await makeAccount(user, `${RUN_TAG}-F7`);
    await seedTransactions(user, folio, equity, [
      { type: 'purchase', date: '2024-01-10', units: 100, amount: 250000 },
      { type: 'sale', date: '2025-01-20', units: 40, amount: 120000 },
    ]);
    await seedPosition(user, folio, equity, { units: 60, value: 190000, asOf: '2025-06-30' });

    const { summary, cards } = await overviewFor(user);
    // The workspace states what is actually held, not "mutual funds".
    expect(summary.portfolio.instrumentClasses).toEqual(['equity']);

    // Look-through is NOT APPLICABLE — there is nothing inside a direct share.
    const xray = cards.find((c) => c.key === 'xray')!;
    expect(xray.status).toBe('NOT_APPLICABLE');
    expect(xray.detail).toMatch(/no mutual funds or ETFs/i);

    // 'sale' MUST count as a disposal (the R12 defect R6 originally missed).
    expect(summary.signals.disposalCount).toBe(1);
    expect(cardStatus(cards, 'tax')).toBe('AVAILABLE');
  }, 120_000);
});

// ===========================================================================
// PC2-U8 — AU resident holding Indian investments (spec section 27).
// ===========================================================================
describe('PC2-U8 — AU resident with Indian investments', () => {
  it('keeps the source currency and does not infer eligibility from display currency', async () => {
    const user = await makeUser('u8', 'AU');
    const fund = await makeInstrument(`${RUN_TAG} CrossBorder Fund`, 'mutual_fund', `INF${STAMP % 1000000}X1`);
    // The account is an INDIAN folio held by an AU-resident household.
    const folio = await makeAccount(user, `${RUN_TAG}-F8`, 'INR', 'IN');
    await seedTransactions(user, folio, fund, [{ type: 'purchase', date: '2024-06-01', units: 100, amount: 10000 }]);
    await seedPosition(user, folio, fund, { units: 100, value: 12000, asOf: '2025-06-30', currency: 'INR' });

    const { summary } = await overviewFor(user);
    // Jurisdiction/currency preserved: the holding stays INR and is NOT
    // converted or reclassified because the household is Australian.
    expect(summary.portfolio.valueByCurrency).toHaveLength(1);
    expect(summary.portfolio.valueByCurrency[0].currencyCode).toBe('INR');
    expect(summary.portfolio.valueByCurrency[0].totalValue).toBeCloseTo(12000, 2);
    expect(summary.portfolio.positionCount).toBe(1);
  }, 120_000);
});

// ===========================================================================
// Multi-currency — the Overview must never blend currencies into one total.
// ===========================================================================
describe('Currency-aware aggregation', () => {
  it('reports each currency separately rather than summing them', async () => {
    const user = await makeUser('mc');
    const inrFund = await makeInstrument(`${RUN_TAG} INR Fund`, 'mutual_fund', `INF${STAMP % 1000000}I1`);
    const audFund = await makeInstrument(`${RUN_TAG} AUD Fund`, 'mutual_fund', `INF${STAMP % 1000000}A2`);
    const inrFolio = await makeAccount(user, `${RUN_TAG}-MC-INR`, 'INR', 'IN');
    const audFolio = await makeAccount(user, `${RUN_TAG}-MC-AUD`, 'AUD', 'AU');
    await seedPosition(user, inrFolio, inrFund, { units: 100, value: 50000, asOf: '2025-06-30', currency: 'INR' });
    await seedPosition(user, audFolio, audFund, { units: 10, value: 2000, asOf: '2025-06-30', currency: 'AUD' });

    const { summary } = await overviewFor(user);
    expect(summary.portfolio.valueByCurrency).toHaveLength(2);
    const codes = summary.portfolio.valueByCurrency.map((c) => c.currencyCode);
    expect(codes).toEqual(['AUD', 'INR']);
    // The critical assertion: 50000 and 2000 are NEVER added to make 52000.
    for (const entry of summary.portfolio.valueByCurrency) {
      expect(entry.totalValue).not.toBe(52000);
    }
    expect(summary.portfolio.valueByCurrency.find((c) => c.currencyCode === 'INR')!.totalValue).toBeCloseTo(50000, 2);
    expect(summary.portfolio.valueByCurrency.find((c) => c.currencyCode === 'AUD')!.totalValue).toBeCloseTo(2000, 2);
  }, 120_000);
});

// ===========================================================================
// SECURITY — spec sections 48-49. The Overview is a NEW aggregation surface.
// ===========================================================================
describe('Overview tenancy isolation', () => {
  it('returns NOTHING of user A when queried with user B\'s real session', async () => {
    const userA = await makeUser('seca');
    const userB = await makeUser('secb');
    const fund = await makeInstrument(`${RUN_TAG} Victim Fund`, 'mutual_fund', `INF${STAMP % 1000000}V1`);
    const folio = await makeAccount(userA, `${RUN_TAG}-SEC`);
    await seedTransactions(userA, folio, fund, [
      { type: 'sip', date: '2024-01-05', units: 100, amount: 10000 },
      { type: 'sip', date: '2024-02-05', units: 100, amount: 10000 },
      { type: 'sip', date: '2024-03-05', units: 100, amount: 10000 },
      { type: 'redemption', date: '2025-01-05', units: 50, amount: 8000 },
    ]);
    await seedPosition(userA, folio, fund, { units: 250, value: 40000, asOf: '2025-06-30' });

    // Sanity: A really does have data (otherwise the negative control below
    // would pass vacuously — the exact failure mode PC1 found in an earlier
    // "27-check" suite).
    const ownView = await overviewFor(userA);
    expect(ownView.summary.portfolio.positionCount).toBe(1);
    expect(ownView.summary.signals.transactionCount).toBe(4);
    expect(ownView.summary.signals.disposalCount).toBe(1);

    // THE ATTACK: user B's genuine JWT, asking for user A's id.
    const crossTenant = await buildOverviewSummary(userB.client, userA.userId);
    expect(crossTenant.portfolio.positionCount, 'RLS must hide user A positions from user B').toBe(0);
    expect(crossTenant.portfolio.valueByCurrency).toHaveLength(0);
    expect(crossTenant.signals.transactionCount).toBe(0);
    expect(crossTenant.signals.disposalCount).toBe(0);
    expect(crossTenant.signals.contributionCount).toBe(0);
    expect(crossTenant.dataQuality.documentCount).toBe(0);
    expect(crossTenant.dataQuality.certifiedPositionCount).toBe(0);

    // And B's own honest view is empty too.
    const ownB = await overviewFor(userB);
    expect(ownB.summary.portfolio.positionCount).toBe(0);
    expect(cardStatus(ownB.cards, 'performance')).toBe('NOT_ENOUGH_DATA');
  }, 180_000);

  it('exposes nothing to an anonymous client', async () => {
    const anonClient = createSupabaseJsClient(BASE, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const user = await makeUser('anon');
    const fund = await makeInstrument(`${RUN_TAG} Anon Probe Fund`, 'mutual_fund', `INF${STAMP % 1000000}Z1`);
    const folio = await makeAccount(user, `${RUN_TAG}-ANON`);
    await seedPosition(user, folio, fund, { units: 100, value: 99999, asOf: '2025-06-30' });

    // Non-vacuous: the row genuinely exists for its owner.
    expect((await overviewFor(user)).summary.portfolio.positionCount).toBe(1);

    const anonView = await buildOverviewSummary(anonClient, user.userId);
    expect(anonView.portfolio.positionCount).toBe(0);
    expect(anonView.signals.transactionCount).toBe(0);
  }, 180_000);
});

// ===========================================================================
// Discoverability — spec sections 44, 45, 65.
// ===========================================================================
describe('Discoverability', () => {
  it('reaches every analysis from the workspace navigation alone', () => {
    // No tester is given a URL: every analytics destination must be present
    // as a nav entry, and every nav entry must resolve to a real page file.
    const required = ['/performance', '/sip', '/xray', '/tax', '/review'].map((s) => `/investment-intelligence${s}`);
    const navHrefs = II_WORKSPACE_NAV.map((i) => i.href);
    for (const href of required) expect(navHrefs, `${href} must be discoverable from the sub-nav`).toContain(href);

    for (const item of II_WORKSPACE_NAV) {
      const rel = item.href === '/investment-intelligence' ? 'app/(app)/investment-intelligence/page.tsx' : `app/(app)${item.href}/page.tsx`;
      expect(fs.existsSync(path.join(repoRoot, rel)), `${item.href} must resolve to a real page (${rel})`).toBe(true);
    }
  });
});
