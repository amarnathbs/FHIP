// Multi-folio fix (PO decision 2026-10-01): a mutual fund held in MORE THAN ONE
// folio (several ii_accounts rows for one ii_instruments row; e.g. the PO's
// sample report lists HDFC Flexi Cap folio 19960529/05 twice) must be read as
// ONE scheme whose units / value / XIRR / exposure are the AGGREGATE of its
// folios, by every scheme-level consumer, while the Holdings table stays per
// folio. Units transacted AFTER a folio's statement date are part of its
// holding (rule 8 of the shared valuation rule).
//
// Drives the REAL repositories (Holdings, Performance + the real orchestrator,
// X-Ray, Overview, Report data) against a filtering in-memory Supabase double,
// with "today" pinned to 2026-09-28.
//
// WORKED FIXTURE (all INR, hand-computed)
// ----------------------------------------
//   S1 HDFC Flexi Cap (AMC "HDFC Mutual Fund"), TWO folios:
//        folio F1 (acc-a1): buy 60000 / 600 units 2025-01-10; statement 2026-06-30: 600 units, 66000
//        folio F2 (acc-a2): buy 40000 / 400 units 2025-06-10; statement 2026-08-31: 400 units, 48000
//        NAV 2026-09-25 @130 (newer than both statements)
//        => F1 600 x 130 = 78000, F2 400 x 130 = 52000, scheme 1000 units / 130000 dated 2026-09-25
//   S2 ICICI Bluechip (AMC "ICICI Prudential Mutual Fund"), one folio (acc-b1):
//        buy 50000 / 500 units 2025-03-01; statement 2026-09-20: 500 units, 55000; NAV 2026-09-25 @112
//        => 500 x 112 = 56000
//   S3 HDFC Mid-Cap (AMC "HDFC Mutual Fund"), one folio (acc-a1, the SAME folio as S1/F1):
//        buy 30000 / 300 units 2025-04-01; statement 2026-09-26: 300 units, 36000 (NAV 120);
//        latest NAV 2026-09-24 @118 is OLDER than the statement => statement value 36000
//   Portfolio 130000 + 56000 + 36000 = 222000; HDFC 166000 (2 schemes), ICICI 56000.
//
// NEGATIVE CONTROLS. Each rule is a check function run against the real code (must
// pass) AND against a deliberately broken variant (must throw the rule's own named
// message). The cross-consumer assertions were additionally run against the
// pre-fix repository files (see docs/investment-intelligence/MULTIFOLIO_FIX_REPORT.md).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadHoldingsTable } from '@/lib/services/investment-intelligence/holdingsRepository';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { loadXrayDataset } from '@/lib/services/investment-intelligence/r5Repository';
import { buildOverviewSummary } from '@/lib/services/investment-intelligence/overviewSummary';
import { loadXrayForReport } from '@/lib/services/investmentIntelligenceReportData';
import { buildTransactionLedger } from '@/lib/services/investment-intelligence/transactionLedger';
import { runAnalytics } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { valueHoldingAsOf, type StatementPositionInput, type NavObservationRow } from '@/lib/engines/investment-intelligence/valuation/currentHoldingValuation';
import { valueSchemeAcrossFolios, aggregateFolioValuationPoints } from '@/lib/engines/investment-intelligence/valuation/schemeValuation';
import { makeFilteringClient, type Row } from './support/filteringSupabase';

// ---------------------------------------------------------------------------
// An independent XIRR (actual/365, pure bisection) so the expected rates are
// NOT produced by FHIP's own xirr().
// ---------------------------------------------------------------------------
function oracleXirr(flows: Array<[string, number]>): number {
  const ms = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
  const t0 = Math.min(...flows.map(([d]) => ms(d)));
  const npv = (r: number) => flows.reduce((s, [d, a]) => s + a / Math.pow(1 + r, (ms(d) - t0) / (365 * 86_400_000)), 0);
  let lo = -0.9;
  let hi = 5;
  if (npv(lo) * npv(hi) > 0) throw new Error('oracle: no sign change');
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------
const USER = 'user-mf';
const OTHER = 'user-other';

interface TxSpec { id: string; type: string; date: string; amount: number; units: number; status?: string }
interface StmtSpec { date: string; units: number; value: number }
interface FolioSpec { acc: string; folio: string; owner?: string; txs: TxSpec[]; stmts: StmtSpec[] }
interface SchemeSpec { id: string; name: string; amc: string; isin: string; folios: FolioSpec[]; navs: Array<{ date: string; price: number; quality?: string; currency?: string }> }

function buildTables(user: string, schemes: SchemeSpec[]): Record<string, Row[]> {
  const t: Record<string, Row[]> = {
    ii_portfolio_truth_status: [], ii_transactions: [], ii_holding_snapshots: [], ii_instruments: [],
    ii_accounts: [], ii_source_documents: [{ id: 'doc-1', user_id: user, source_detected: 'cams', status: 'processed' }],
    ii_scheme_master: [], ii_prices_nav: [],
  };
  const seenAcc = new Set<string>();
  for (const s of schemes) {
    t.ii_instruments.push({ id: s.id, instrument_name: s.name, base_currency: 'INR', country_of_domicile: 'IN', isin: s.isin, instrument_class: 'mutual_fund' });
    t.ii_scheme_master.push({ instrument_id: s.id, scheme_name: s.name, amc_name: s.amc, effective_to: null });
    s.navs.forEach((n, i) => t.ii_prices_nav.push({ id: `nav-${s.id}-${i}`, instrument_id: s.id, price_date: n.date, price: n.price, currency_code: n.currency ?? 'INR', quality_status: n.quality ?? 'ok', data_version: 'v1' }));
    for (const f of s.folios) {
      if (!seenAcc.has(f.acc)) {
        seenAcc.add(f.acc);
        t.ii_accounts.push({ id: f.acc, user_id: user, folio_number: f.folio, institution_name: s.amc, currency_code: 'INR', owner_member_id: f.owner ?? null });
      }
      t.ii_portfolio_truth_status.push({ id: `truth-${f.acc}-${s.id}`, user_id: user, account_id: f.acc, instrument_id: s.id, status: 'certified', unit_variance_within_tolerance: true, latest_source_document_id: 'doc-1', history_completeness: 'complete_from_inception' });
      for (const x of f.txs) t.ii_transactions.push({ id: x.id, user_id: user, account_id: f.acc, instrument_id: s.id, transaction_type: x.type, transaction_date: x.date, gross_amount: x.amount, units: x.units, price_per_unit: x.units ? x.amount / x.units : null, source_description: x.type, currency_code: 'INR', status: x.status ?? 'parsed' });
      f.stmts.forEach((st, i) => t.ii_holding_snapshots.push({ id: `snap-${f.acc}-${s.id}-${i}`, user_id: user, account_id: f.acc, instrument_id: s.id, as_of_date: st.date, units: st.units, value: st.value, currency_code: 'INR', quality_status: 'certified', source_document_id: 'doc-1' }));
    }
  }
  return t;
}

function merge(...parts: Array<Record<string, Row[]>>): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const p of parts) for (const [k, v] of Object.entries(p)) out[k] = [...(out[k] ?? []), ...v];
  return out;
}

const NAV_S1 = [{ date: '2026-06-30', price: 110 }, { date: '2026-08-31', price: 120 }, { date: '2026-09-25', price: 130 }];

function s1(overrides: { f2?: Partial<FolioSpec>; extraNavs?: SchemeSpec['navs'] } = {}): SchemeSpec {
  return {
    id: 'inst-s1', name: 'HDFC Flexi Cap Fund', amc: 'HDFC Mutual Fund', isin: 'INF179K01XX1',
    folios: [
      { acc: 'acc-a1', folio: '19960529/05', owner: 'mem-1', txs: [{ id: 'tx-s1-f1', type: 'purchase', date: '2025-01-10', amount: 60000, units: 600 }], stmts: [{ date: '2026-06-30', units: 600, value: 66000 }] },
      { acc: 'acc-a2', folio: '19960529/05', owner: 'mem-2', txs: [{ id: 'tx-s1-f2', type: 'purchase', date: '2025-06-10', amount: 40000, units: 400 }], stmts: [{ date: '2026-08-31', units: 400, value: 48000 }], ...(overrides.f2 ?? {}) },
    ],
    navs: [...NAV_S1, ...(overrides.extraNavs ?? [])],
  };
}
const S2: SchemeSpec = {
  id: 'inst-s2', name: 'ICICI Prudential Bluechip Fund', amc: 'ICICI Prudential Mutual Fund', isin: 'INF109K01XX2',
  folios: [{ acc: 'acc-b1', folio: '7711/22', txs: [{ id: 'tx-s2', type: 'purchase', date: '2025-03-01', amount: 50000, units: 500 }], stmts: [{ date: '2026-09-20', units: 500, value: 55000 }] }],
  navs: [{ date: '2026-09-20', price: 110 }, { date: '2026-09-25', price: 112 }],
};
const S3: SchemeSpec = {
  id: 'inst-s3', name: 'HDFC Mid-Cap Opportunities Fund', amc: 'HDFC Mutual Fund', isin: 'INF179K01XX3',
  folios: [{ acc: 'acc-a1', folio: '19960529/05', owner: 'mem-1', txs: [{ id: 'tx-s3', type: 'purchase', date: '2025-04-01', amount: 30000, units: 300 }], stmts: [{ date: '2026-09-26', units: 300, value: 36000 }] }],
  navs: [{ date: '2026-09-24', price: 118 }],
};

interface All {
  holdings: Awaited<ReturnType<typeof loadHoldingsTable>>;
  results: ReturnType<typeof runAnalytics>;
  dataset: NonNullable<Awaited<ReturnType<typeof loadAnalyticsDataset>>['dataset']>;
  analyticsWarnings: Array<{ scope: string; detail: string }>;
  xray: NonNullable<Awaited<ReturnType<typeof loadXrayDataset>>['dataset']>;
  overview: Awaited<ReturnType<typeof buildOverviewSummary>>;
  report: Awaited<ReturnType<typeof loadXrayForReport>>;
}

async function observe(client: SupabaseClient, user = USER): Promise<All> {
  const holdings = await loadHoldingsTable(client, user);
  const a = await loadAnalyticsDataset(client, user);
  const x = await loadXrayDataset(client, user);
  const overview = await buildOverviewSummary(client, user);
  const report = await loadXrayForReport(user, client as never);
  return { holdings, results: runAnalytics(a.dataset!), dataset: a.dataset!, analyticsWarnings: a.warnings, xray: x.dataset!, overview, report };
}

const clientFor = (tables: Record<string, Row[]>) => makeFilteringClient(tables);
const rate = (o: { status: string; value?: { rate: number } | null } | undefined) => o?.value?.rate as number;
const iso = (d: Date) => d.toISOString().slice(0, 10);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// 1. Two folios of one scheme aggregate in every scheme-level consumer; the
//    Holdings table stays per folio; everything reconciles to the rupee.
// ===========================================================================
describe('MF-1: a fund held in two folios is ONE scheme with the SUM of its folios', () => {
  it('Holdings stays per folio (78000 + 52000); Performance, X-Ray, Overview and Report data all show the aggregate 130000 / 222000', async () => {
    const tables = merge(buildTables(USER, [s1(), S2, S3]));
    const o = await observe(clientFor(tables));

    // --- Holdings: per folio, unchanged semantics ---
    const rowsS1 = o.holdings.holdings.filter((h) => h.instrumentId === 'inst-s1');
    expect(rowsS1).toHaveLength(2);
    const f1 = rowsS1.find((h) => h.accountId === 'acc-a1')!;
    const f2 = rowsS1.find((h) => h.accountId === 'acc-a2')!;
    expect([f1.unitBalance, f1.marketValue, f1.navDate, f1.valuationBasis]).toEqual([600, 78000, '2026-09-25', 'market_nav']);
    expect([f2.unitBalance, f2.marketValue, f2.navDate, f2.valuationBasis]).toEqual([400, 52000, '2026-09-25', 'market_nav']);
    expect(f1.costValue).toBe(60000);
    expect(f2.costValue).toBe(40000);
    const holdingsTotal = o.holdings.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
    expect(holdingsTotal).toBe(222000);

    // --- Performance: scheme-level value is the SUM of the folios ---
    const sch1 = o.dataset.schemes.find((s) => s.instrumentId === 'inst-s1')!;
    expect(sch1.currentValue).toBe(130000);
    expect(iso(sch1.currentValueDate)).toBe('2026-09-25');
    expect(o.dataset.schemes.find((s) => s.instrumentId === 'inst-s2')!.currentValue).toBe(56000);
    expect(o.dataset.schemes.find((s) => s.instrumentId === 'inst-s3')!.currentValue).toBe(36000);
    const perfTotal = o.dataset.schemes.reduce((s, x) => s + x.currentValue, 0);

    // --- X-Ray: ONE position per scheme carrying the summed value (exposure counted once) ---
    expect(o.xray.positions).toHaveLength(3);
    const xp1 = o.xray.positions.filter((p) => p.fundInstrumentId === 'inst-s1');
    expect(xp1).toHaveLength(1);
    expect(xp1[0].value).toBe(130000);
    const xrayTotal = o.xray.positions.reduce((s, p) => s + p.value, 0);

    // --- Overview: per-position sum ---
    const overviewTotal = o.overview.portfolio.valueByCurrency[0].totalValue;
    expect(o.overview.portfolio.positionCount).toBe(4); // 4 folio positions ...
    expect(o.overview.portfolio.instrumentCount).toBe(3); // ... of 3 schemes

    // --- Report data (built from the X-Ray loader) ---
    const reportTotal = o.report!.results.lookThrough.totalPortfolioValue;
    const hdfc = o.report!.results.amcConcentration.buckets.find((b) => b.amcName === 'HDFC Mutual Fund')!;
    const icici = o.report!.results.amcConcentration.buckets.find((b) => b.amcName === 'ICICI Prudential Mutual Fund')!;
    expect([hdfc.value, hdfc.schemeCount]).toEqual([166000, 2]);
    expect([icici.value, icici.schemeCount]).toEqual([56000, 1]);

    // --- The five consumers agree to the rupee ---
    expect(new Set([holdingsTotal, perfTotal, xrayTotal, overviewTotal, reportTotal])).toEqual(new Set([222000]));
  });

  it('RULE MF-1 negative control: the pre-fix input assembly (latest statement of the INSTRUMENT, whichever folio) is wrong, and the check names it', () => {
    const f1: StatementPositionInput[] = [{ asOfDate: '2026-06-30', units: 600, value: 66000, currencyCode: 'INR' }];
    const f2: StatementPositionInput[] = [{ asOfDate: '2026-08-31', units: 400, value: 48000, currencyCode: 'INR' }];
    const navs: NavObservationRow[] = [{ date: '2026-09-25', price: 130 }];

    const check = (valueScheme: () => { units: number | null; marketValue: number | null }) => {
      const v = valueScheme();
      if (v.units !== 1000 || v.marketValue !== 130000) throw new Error(`RULE MF-1: two folios must aggregate (expected 1000 units / 130000, got ${v.units} / ${v.marketValue})`);
    };
    const real = () => valueSchemeAcrossFolios({ folios: [{ folioKey: 'acc-a1', statements: f1 }, { folioKey: 'acc-a2', statements: f2 }], navs, asOfDate: '2026-09-28' });
    // The pre-fix behaviour: statements grouped by instrument only, one winner.
    const preFix = () => {
      const merged = [...f1, ...f2].sort((a, b) => (a.asOfDate < b.asOfDate ? -1 : 1));
      const v = valueHoldingAsOf({ statements: merged, navs, asOfDate: '2026-09-28' });
      return { units: v.units, marketValue: v.marketValue };
    };
    expect(() => check(real)).not.toThrow();
    expect(() => check(preFix)).toThrow(/RULE MF-1: two folios must aggregate \(expected 1000 units \/ 130000, got 400 \/ 52000\)/);
  });

  it('RULE MF-1b negative control: picking only the OLDER folio is wrong too (66000-statement folio alone = 78000, not 130000)', () => {
    const one = valueSchemeAcrossFolios({
      folios: [{ folioKey: 'acc-a1', statements: [{ asOfDate: '2026-06-30', units: 600, value: 66000 }] }],
      navs: [{ date: '2026-09-25', price: 130 }],
      asOfDate: '2026-09-28',
    });
    expect(one.marketValue).toBe(78000);
    expect(one.marketValue).not.toBe(130000);
  });
});

// ===========================================================================
// 2. XIRR over the union of flows vs an independent oracle.
// ===========================================================================
describe('MF-2: scheme, folio and portfolio XIRR use the union of the folios\' flows', () => {
  it('scheme XIRR = oracle over {-60000 2025-01-10, -40000 2025-06-10, +130000 2026-09-25}; folio XIRRs = their own oracles; portfolio XIRR = oracle over all flows', async () => {
    const tables = merge(buildTables(USER, [s1(), S2, S3]));
    const o = await observe(clientFor(tables));

    const expectedScheme = oracleXirr([['2025-01-10', -60000], ['2025-06-10', -40000], ['2026-09-25', 130000]]);
    const schemeRate = rate(o.results.schemes.find((s) => s.instrumentId === 'inst-s1')!.investorXirr);
    expect(schemeRate).toBeCloseTo(expectedScheme, 6);

    // Per-folio XIRR (Holdings rows): each folio on its own flows and own value.
    const expF1 = oracleXirr([['2025-01-10', -60000], ['2026-09-25', 78000]]);
    const expF2 = oracleXirr([['2025-06-10', -40000], ['2026-09-25', 52000]]);
    const rows = o.holdings.holdings.filter((h) => h.instrumentId === 'inst-s1');
    expect(rate(rows.find((h) => h.accountId === 'acc-a1')!.xirr)).toBeCloseTo(expF1, 6);
    expect(rate(rows.find((h) => h.accountId === 'acc-a2')!.xirr)).toBeCloseTo(expF2, 6);
    // ... which are different numbers from the scheme-level XIRR (no longer one repeated figure).
    expect(Math.abs(expF1 - expectedScheme)).toBeGreaterThan(0.001);
    expect(Math.abs(expF2 - expectedScheme)).toBeGreaterThan(0.001);

    // Single-folio schemes: the Holdings row and the scheme figure are still one number.
    const s2Row = o.holdings.holdings.find((h) => h.instrumentId === 'inst-s2')!;
    expect(rate(s2Row.xirr)).toBeCloseTo(rate(o.results.schemes.find((s) => s.instrumentId === 'inst-s2')!.investorXirr), 12);
    expect(rate(s2Row.xirr)).toBeCloseTo(oracleXirr([['2025-03-01', -50000], ['2026-09-25', 56000]]), 6);

    // Portfolio XIRR: every real flow once; ONE terminal value (222000) at the latest valuation date (2026-09-26, S3's statement).
    const expPortfolio = oracleXirr([
      ['2025-01-10', -60000], ['2025-06-10', -40000], ['2025-03-01', -50000], ['2025-04-01', -30000], ['2026-09-26', 222000],
    ]);
    expect(rate(o.results.portfolios[0].portfolioXirr)).toBeCloseTo(expPortfolio, 6);
    expect(o.results.portfolios[0].totalValue).toBe(222000);
  });

  it('NEGATIVE CONTROL: the XIRR a one-folio-only terminal value would give (52000, the pre-fix Performance value) is far from the real figure, so the assertion above can fail', async () => {
    const real = oracleXirr([['2025-01-10', -60000], ['2025-06-10', -40000], ['2026-09-25', 130000]]);
    const preFix = oracleXirr([['2025-01-10', -60000], ['2025-06-10', -40000], ['2026-09-25', 52000]]);
    expect(Math.abs(real - preFix)).toBeGreaterThan(0.2);
    const o = await observe(clientFor(buildTables(USER, [s1()])));
    const got = rate(o.results.schemes[0].investorXirr);
    // The check the suite makes, applied to the wrong expectation, must fail with a named message.
    const check = (expected: number) => {
      if (Math.abs(got - expected) > 1e-6) throw new Error(`MF-2: scheme XIRR must equal the union-of-flows oracle (expected ${expected.toFixed(4)}, got ${got.toFixed(4)})`);
    };
    expect(() => check(real)).not.toThrow();
    expect(() => check(preFix)).toThrow(/MF-2: scheme XIRR must equal the union-of-flows oracle/);
  });
});

// ===========================================================================
// 3. A redeemed folio and a live folio of the same scheme.
// ===========================================================================
describe('MF-3: a fully redeemed folio plus a live folio of the same scheme', () => {
  const redeemedF2 = {
    txs: [
      { id: 'tx-s1-f2', type: 'purchase', date: '2025-06-10', amount: 40000, units: 400 },
      { id: 'tx-s1-f2r', type: 'redemption', date: '2026-08-20', amount: 45000, units: 400 },
    ],
    stmts: [{ date: '2026-08-31', units: 0, value: 0 }],
  };

  it('the scheme is worth the LIVE folio only (78000) in every consumer; the redeemed folio is 0 and labelled; XIRR includes the redemption flow', async () => {
    const o = await observe(clientFor(buildTables(USER, [s1({ f2: redeemedF2 })])));
    const rows = o.holdings.holdings;
    expect(rows.find((h) => h.accountId === 'acc-a2')!.valuationBasis).toBe('redeemed');
    expect(rows.find((h) => h.accountId === 'acc-a2')!.marketValue).toBe(0);
    expect(rows.find((h) => h.accountId === 'acc-a1')!.marketValue).toBe(78000);
    expect(o.dataset.schemes[0].currentValue).toBe(78000);
    expect(o.xray.positions[0].value).toBe(78000);
    expect(o.overview.portfolio.valueByCurrency[0].totalValue).toBe(78000);
    expect(o.report!.results.lookThrough.totalPortfolioValue).toBe(78000);
    const expected = oracleXirr([['2025-01-10', -60000], ['2025-06-10', -40000], ['2026-08-20', 45000], ['2026-09-25', 78000]]);
    expect(rate(o.results.schemes[0].investorXirr)).toBeCloseTo(expected, 6);
  });

  it('RULE MF-3 negative control: letting the redeemed folio\'s later statement WIN (pre-fix pick-one-statement) values the whole scheme at 0 and the check names it', () => {
    const f1 = [{ asOfDate: '2026-06-30', units: 600, value: 66000 }];
    const f2 = [{ asOfDate: '2026-08-31', units: 0, value: 0 }];
    const navs = [{ date: '2026-09-25', price: 130 }];
    const check = (v: number | null) => {
      if (v !== 78000) throw new Error(`RULE MF-3: the live folio must still count next to a redeemed folio (expected 78000, got ${v})`);
    };
    const real = valueSchemeAcrossFolios({ folios: [{ folioKey: 'a1', statements: f1 }, { folioKey: 'a2', statements: f2 }], navs, asOfDate: '2026-09-28' });
    expect(() => check(real.marketValue)).not.toThrow();
    expect(real.basis).toBe('market_nav');
    const preFix = valueHoldingAsOf({ statements: [...f1, ...f2], navs, asOfDate: '2026-09-28' });
    expect(() => check(preFix.marketValue)).toThrow(/RULE MF-3: the live folio must still count next to a redeemed folio \(expected 78000, got 0\)/);
  });

  it('every folio redeemed => the scheme is redeemed (basis, value 0)', () => {
    const v = valueSchemeAcrossFolios({
      folios: [{ folioKey: 'a1', statements: [{ asOfDate: '2026-06-30', units: 0, value: 0 }] }, { folioKey: 'a2', statements: [{ asOfDate: '2026-08-31', units: 0, value: 0 }] }],
      navs: [{ date: '2026-09-25', price: 130 }],
      asOfDate: '2026-09-28',
    });
    expect([v.basis, v.marketValue, v.units, v.liveFolioCount]).toEqual(['redeemed', 0, 0, 0]);
  });
});

// ===========================================================================
// 4. Units transacted AFTER the statement date (rule 8).
// ===========================================================================
describe('MF-4: units transacted after the snapshot date are part of the holding', () => {
  const single = (extraTxs: TxSpec[], navs: SchemeSpec['navs'], stmtUnits = 100, stmtValue = 10000): SchemeSpec => ({
    id: 'inst-d', name: 'Delta Fund', amc: 'Delta Mutual Fund', isin: 'INF000000099',
    folios: [{ acc: 'acc-d1', folio: 'D-1', txs: [{ id: 'tx-d0', type: 'purchase', date: '2026-01-05', amount: 9500, units: 100 }, ...extraTxs], stmts: [{ date: '2026-06-30', units: stmtUnits, value: stmtValue }] }],
    navs,
  });
  const NAVS = [{ date: '2026-06-30', price: 100 }, { date: '2026-09-25', price: 140 }];

  it('a purchase of 20 units on 2026-09-10 lifts 100 -> 120 units and the value to 120 x 140 = 16800 in Holdings, Performance, X-Ray, Overview and Report data', async () => {
    const o = await observe(clientFor(buildTables(USER, [single([{ id: 'tx-d1', type: 'purchase', date: '2026-09-10', amount: 2600, units: 20 }], NAVS)])));
    const h = o.holdings.holdings[0];
    expect([h.unitBalance, h.marketValue, h.valuationBasis]).toEqual([120, 16800, 'market_nav']);
    expect(h.valuationNote).toMatch(/Includes \+20 units transacted after the statement date/);
    expect(h.costValue).toBe(12100);
    expect(o.dataset.schemes[0].currentValue).toBe(16800);
    expect(o.xray.positions[0].value).toBe(16800);
    expect(o.overview.portfolio.valueByCurrency[0].totalValue).toBe(16800);
    expect(o.report!.results.lookThrough.totalPortfolioValue).toBe(16800);
    const expected = oracleXirr([['2026-01-05', -9500], ['2026-09-10', -2600], ['2026-09-25', 16800]]);
    expect(rate(o.results.schemes[0].investorXirr)).toBeCloseTo(expected, 6);
  });

  it('a partial redemption of 30 units after the statement gives 70 x 140 = 9800 everywhere; a full redemption after the statement gives 0 (redeemed)', async () => {
    const part = await observe(clientFor(buildTables(USER, [single([{ id: 'tx-d2', type: 'redemption', date: '2026-09-12', amount: 4000, units: 30 }], NAVS)])));
    expect([part.holdings.holdings[0].unitBalance, part.holdings.holdings[0].marketValue]).toEqual([70, 9800]);
    expect(part.dataset.schemes[0].currentValue).toBe(9800);
    expect(part.xray.positions[0].value).toBe(9800);
    expect(part.overview.portfolio.valueByCurrency[0].totalValue).toBe(9800);

    const full = await observe(clientFor(buildTables(USER, [single([{ id: 'tx-d3', type: 'redemption', date: '2026-09-12', amount: 14000, units: 100 }], NAVS)])));
    expect(full.holdings.holdings[0].valuationBasis).toBe('redeemed');
    expect(full.holdings.holdings[0].marketValue).toBe(0);
    expect(full.dataset.schemes[0].currentValue).toBe(0);
    expect(full.overview.portfolio.valueByCurrency[0].totalValue).toBe(0);
  });

  it('RULE MF-4 negative control: a rule that ignores later units (the pre-fix behaviour) values the holding at 14000, and the check names it', () => {
    const stmts = [{ asOfDate: '2026-06-30', units: 100, value: 10000 }];
    const navs = [{ date: '2026-09-25', price: 140 }];
    const movements = [{ date: '2026-09-10', unitDelta: 20 }];
    const check = (v: { units: number | null; marketValue: number | null }) => {
      if (v.units !== 120 || v.marketValue !== 16800) throw new Error(`RULE MF-4: units transacted after the snapshot must be counted (expected 120 units / 16800, got ${v.units} / ${v.marketValue})`);
    };
    expect(() => check(valueHoldingAsOf({ statements: stmts, navs, asOfDate: '2026-09-28', unitMovements: movements }))).not.toThrow();
    expect(() => check(valueHoldingAsOf({ statements: stmts, navs, asOfDate: '2026-09-28' }))).toThrow(
      /RULE MF-4: units transacted after the snapshot must be counted \(expected 120 units \/ 16800, got 100 \/ 14000\)/
    );
  });

  it('boundary rules: same-day movement is not counted twice; future-dated and reversed/review_required are ignored; negative balance is not applied; no-newer-NAV prices at the statement NAV', async () => {
    const stmts = [{ asOfDate: '2026-06-30', units: 100, value: 10000 }];
    const navs = [{ date: '2026-09-25', price: 140 }];
    const v = (movs: Array<{ date: string; unitDelta: number }>, n = navs) => valueHoldingAsOf({ statements: stmts, navs: n, asOfDate: '2026-09-28', unitMovements: movs });
    // dated ON the statement date: already inside the statement figure
    expect(v([{ date: '2026-06-30', unitDelta: 10 }]).units).toBe(100);
    // dated after the valuation date: not yet happened
    expect(v([{ date: '2026-10-05', unitDelta: 10 }]).units).toBe(100);
    // negative balance would result: not applied, disclosed
    const neg = v([{ date: '2026-09-01', unitDelta: -150 }]);
    expect([neg.units, neg.marketValue, neg.unitsAfterStatementApplied]).toEqual([100, 14000, false]);
    expect(neg.note).toMatch(/net to a negative balance, so they were not applied/);
    // no market NAV newer than the statement: extra units priced at the statement NAV (100), basis stays 'statement'
    const noNav = v([{ date: '2026-09-10', unitDelta: 20 }], [{ date: '2026-06-30', price: 100 }]);
    expect([noNav.basis, noNav.units, noNav.marketValue, noNav.unitsAfterStatementApplied]).toEqual(['statement', 120, 12000, true]);
    // statement held 0 units and no newer NAV: cannot price the new units -> not applied, disclosed
    const unpriced = valueHoldingAsOf({ statements: [{ asOfDate: '2026-06-30', units: 0, value: 0 }], navs: [], asOfDate: '2026-09-28', unitMovements: [{ date: '2026-09-10', unitDelta: 20 }] });
    expect([unpriced.units, unpriced.marketValue, unpriced.unitsAfterStatementApplied]).toEqual([0, 0, false]);
    expect(unpriced.note).toMatch(/could not be priced/);

    // end to end: reversed and review_required transactions never add units
    const o = await observe(
      clientFor(
        buildTables(USER, [
          {
            id: 'inst-e', name: 'Echo Fund', amc: 'Echo Mutual Fund', isin: 'INF000000098',
            folios: [{ acc: 'acc-e1', folio: 'E-1', txs: [
              { id: 'e0', type: 'purchase', date: '2026-01-05', amount: 9500, units: 100 },
              { id: 'e1', type: 'purchase', date: '2026-09-10', amount: 2600, units: 20, status: 'reversed' },
              { id: 'e2', type: 'purchase', date: '2026-09-11', amount: 1300, units: 10, status: 'review_required' },
            ], stmts: [{ date: '2026-06-30', units: 100, value: 10000 }] }],
            navs: [{ date: '2026-09-25', price: 140 }],
          },
        ])
      )
    );
    expect(o.holdings.holdings[0].unitBalance).toBe(100);
    expect(o.dataset.schemes[0].currentValue).toBe(14000);
  });

  it('a later-dated purchase in the SECOND folio only lifts that folio (per-folio attribution)', async () => {
    const withLater = s1({ f2: { txs: [{ id: 'tx-s1-f2', type: 'purchase', date: '2025-06-10', amount: 40000, units: 400 }, { id: 'tx-s1-f2b', type: 'purchase', date: '2026-09-15', amount: 6000, units: 50 }] } });
    const o = await observe(clientFor(buildTables(USER, [withLater])));
    const rows = o.holdings.holdings;
    expect(rows.find((h) => h.accountId === 'acc-a1')!.marketValue).toBe(78000);
    expect(rows.find((h) => h.accountId === 'acc-a2')!.unitBalance).toBe(450);
    expect(rows.find((h) => h.accountId === 'acc-a2')!.marketValue).toBe(58500);
    expect(o.dataset.schemes[0].currentValue).toBe(136500);
    expect(o.xray.positions[0].value).toBe(136500);
    expect(o.overview.portfolio.valueByCurrency[0].totalValue).toBe(136500);
  });
});

// ===========================================================================
// 5. Per-folio attribution under different owners; ownership semantics untouched.
// ===========================================================================
describe('MF-5: the same fund in two folios under different owners stays attributable per folio', () => {
  it('Holdings keeps one row per folio with its own account, units and value (owners mem-1 / mem-2); the scheme view is their sum; no ownership column is read or written', async () => {
    const o = await observe(clientFor(buildTables(USER, [s1()])));
    const rows = o.holdings.holdings.filter((h) => h.instrumentId === 'inst-s1');
    expect(rows.map((r) => [r.accountId, r.unitBalance, r.marketValue])).toEqual(
      expect.arrayContaining([['acc-a1', 600, 78000], ['acc-a2', 400, 52000]])
    );
    expect(o.dataset.schemes[0].currentValue).toBe(rows.reduce((s, r) => s + (r.marketValue ?? 0), 0));
    // The per-folio XIRR map is keyed by account id, so each folio (hence each owner) stays attributable.
    expect(Object.keys(o.results.schemes[0].folioXirr ?? {}).sort()).toEqual(['acc-a1', 'acc-a2']);

    // Ownership semantics are another branch's work: none of the files touched here may read or write them.
    const touched = [
      'lib/services/investment-intelligence/analyticsRepository.ts',
      'lib/services/investment-intelligence/r5Repository.ts',
      'lib/services/investment-intelligence/holdingsRepository.ts',
      'lib/services/investment-intelligence/overviewSummary.ts',
      'lib/services/investment-intelligence/currentValuationLoader.ts',
      'lib/engines/investment-intelligence/valuation/currentHoldingValuation.ts',
      'lib/engines/investment-intelligence/valuation/schemeValuation.ts',
    ];
    for (const f of touched) {
      const src = readFileSync(path.join(process.cwd(), f), 'utf8');
      expect(src, `${f} must not touch ownership`).not.toMatch(/owner_member_id|ownership_share|joint_owner/i);
    }
  });
});

// ===========================================================================
// 6. Cross-user isolation.
// ===========================================================================
describe('MF-6: cross-user isolation', () => {
  it('another user\'s folios of the SAME fund never enter this user\'s units, value, XIRR or exposure (and vice versa)', async () => {
    const mine = buildTables(USER, [s1(), S2, S3]);
    const theirs = buildTables(OTHER, [{
      id: 'inst-s1', name: 'HDFC Flexi Cap Fund', amc: 'HDFC Mutual Fund', isin: 'INF179K01XX1', navs: [],
      folios: [{ acc: 'acc-x9', folio: 'X9', txs: [{ id: 'tx-x9', type: 'purchase', date: '2024-01-01', amount: 9_000_000, units: 90000 }], stmts: [{ date: '2026-09-27', units: 90000, value: 11_700_000 }] }],
    }]);
    const alone = await observe(clientFor(mine));
    const shared = await observe(clientFor(merge(mine, theirs)));
    expect(shared.dataset.schemes.find((s) => s.instrumentId === 'inst-s1')!.currentValue).toBe(130000);
    expect(shared.overview.portfolio.valueByCurrency[0].totalValue).toBe(222000);
    expect(shared.xray.positions.find((p) => p.fundInstrumentId === 'inst-s1')!.value).toBe(130000);
    expect(shared.holdings.holdings).toHaveLength(alone.holdings.holdings.length);
    expect(rate(shared.results.schemes.find((s) => s.instrumentId === 'inst-s1')!.investorXirr)).toBe(rate(alone.results.schemes.find((s) => s.instrumentId === 'inst-s1')!.investorXirr));
    // The other user sees only their own folio.
    const theirView = await observe(clientFor(merge(mine, theirs)), OTHER);
    expect(theirView.dataset.schemes[0].currentValue).toBe(90000 * 130);
    expect(theirView.holdings.holdings.map((h) => h.accountId)).toEqual(['acc-x9']);
  });

  it('NEGATIVE CONTROL: a loader that dropped the user filter would leak the other user\'s 11,700,000 - proven by running the double without the filter', () => {
    const client = clientFor(merge(buildTables(USER, [s1()]), buildTables(OTHER, [{ id: 'inst-s1', name: 'HDFC Flexi Cap Fund', amc: 'HDFC Mutual Fund', isin: 'INF179K01XX1', navs: [], folios: [{ acc: 'acc-x9', folio: 'X9', txs: [], stmts: [{ date: '2026-09-27', units: 90000, value: 11_700_000 }] }] }])));
    return (client.from('ii_holding_snapshots').select('*') as unknown as PromiseLike<{ data: Row[] }>).then((r) => {
      // With no .eq('user_id', ...) the double returns BOTH users' rows - so the isolation test above is only green because the repositories filter.
      expect(r.data.some((row) => row.user_id === OTHER)).toBe(true);
      expect(r.data.some((row) => row.user_id === USER)).toBe(true);
    });
  });
});

// ===========================================================================
// 7. Point-in-time, per-folio.
// ===========================================================================
describe('MF-7: an explicit historical date never lets a later folio statement leak in', () => {
  it('as of 2026-08-15 only F1 (statement 2026-06-30) exists: Performance and X-Ray value the scheme at 600 x the 2026-08-10 NAV 120 = 72000', async () => {
    const tables = buildTables(USER, [s1({ extraNavs: [{ date: '2026-08-10', price: 120 }] })]);
    const client = clientFor(tables);
    const a = await loadAnalyticsDataset(client, USER, { asOfDate: new Date('2026-08-15T00:00:00.000Z') });
    expect(a.dataset!.schemes[0].currentValue).toBe(72000);
    const x = await loadXrayDataset(client, USER, { asOfDate: '2026-08-15' });
    expect(x.dataset!.positions[0].value).toBe(72000);
    // NEGATIVE CONTROL: F2's statement is dated 2026-08-31; with the date bound ignored its 400 units would add 48000.
    const leaky = valueSchemeAcrossFolios({
      folios: [{ folioKey: 'a1', statements: [{ asOfDate: '2026-06-30', units: 600, value: 66000 }] }, { folioKey: 'a2', statements: [{ asOfDate: '2026-08-31', units: 400, value: 48000 }] }],
      navs: [{ date: '2026-08-10', price: 120 }], asOfDate: '2026-08-15', pointInTime: false,
    });
    expect(leaky.marketValue).not.toBe(72000);
    const bounded = valueSchemeAcrossFolios({
      folios: [{ folioKey: 'a1', statements: [{ asOfDate: '2026-06-30', units: 600, value: 66000 }] }, { folioKey: 'a2', statements: [{ asOfDate: '2026-08-31', units: 400, value: 48000 }] }],
      navs: [{ date: '2026-08-10', price: 120 }], asOfDate: '2026-08-15', pointInTime: true,
    });
    expect(bounded.marketValue).toBe(72000);
    expect(bounded.valuedFolioCount).toBe(1);
  });
});

// ===========================================================================
// 8. Valuation series + folio without a statement.
// ===========================================================================
describe('MF-8: the dated valuation series sums the folios; a folio with no statement is disclosed', () => {
  it('valuationSeries has 66000 on 2026-06-30 and 66000 + 48000 = 114000 on 2026-08-31 (not the lone 48000 of the latest folio)', async () => {
    const o = await observe(clientFor(buildTables(USER, [s1()])));
    const series = o.dataset.schemes[0].valuationSeries.map((p) => [iso(p.date), p.value]);
    expect(series).toEqual([['2026-06-30', 66000], ['2026-08-31', 114000]]);
  });

  it('RULE MF-8 negative control: the pre-fix series (every folio snapshot as its own point) gives 48000 on 2026-08-31 and the check names it', () => {
    const f1 = { points: [{ date: '2026-06-30', value: 66000 }] };
    const f2 = { points: [{ date: '2026-08-31', value: 48000 }] };
    const check = (pts: Array<{ date: string; value: number }>) => {
      const at = pts.find((p) => p.date === '2026-08-31');
      if (at?.value !== 114000) throw new Error(`RULE MF-8: the scheme valuation on 2026-08-31 must include both folios (expected 114000, got ${at?.value})`);
    };
    expect(() => check(aggregateFolioValuationPoints([f1, f2]))).not.toThrow();
    const preFix = [...f1.points, ...f2.points];
    expect(() => check(preFix)).toThrow(/RULE MF-8: the scheme valuation on 2026-08-31 must include both folios \(expected 114000, got 48000\)/);
    // a single folio is returned exactly as given
    expect(aggregateFolioValuationPoints([f1])).toEqual(f1.points);
  });

  it('a folio that has transactions but no statement is disclosed as a warning and its holding is not silently invented', async () => {
    const t = buildTables(USER, [s1()]);
    t.ii_transactions.push({ id: 'tx-orphan', user_id: USER, account_id: 'acc-a3', instrument_id: 'inst-s1', transaction_type: 'purchase', transaction_date: '2025-09-01', gross_amount: 5000, units: 50, currency_code: 'INR', status: 'parsed' });
    t.ii_accounts.push({ id: 'acc-a3', user_id: USER, folio_number: 'NEW', institution_name: 'HDFC Mutual Fund', currency_code: 'INR', owner_member_id: null });
    const a = await loadAnalyticsDataset(clientFor(t), USER);
    expect(a.dataset!.schemes[0].currentValue).toBe(130000);
    expect(a.warnings.some((w) => w.scope === 'valuation' && /no statement valuation/.test(w.detail))).toBe(true);
  });
});

// ===========================================================================
// 9. Single-folio behaviour is byte-identical (no regression).
// ===========================================================================
describe('MF-9: a single-folio scheme is valued exactly as before', () => {
  it('no folios[] slice, no folioXirr, value = units x latest eligible NAV, Holdings XIRR = the scheme XIRR', async () => {
    const o = await observe(clientFor(buildTables(USER, [S2])));
    expect(o.dataset.schemes[0].folios).toBeUndefined();
    expect(o.results.schemes[0].folioXirr).toBeUndefined();
    expect(o.dataset.schemes[0].currentValue).toBe(56000);
    expect(o.holdings.holdings[0].marketValue).toBe(56000);
    expect(rate(o.holdings.holdings[0].xirr)).toBe(rate(o.results.schemes[0].investorXirr));
  });
});

// ===========================================================================
// 10. The per-folio transaction ledger (modal) agrees with the Holdings row.
// ===========================================================================
describe('MF-10: the folio ledger closes on the same per-folio value and XIRR as its Holdings row', () => {
  it('folio F1 closes at 78000 dated 2026-09-25 (its own 600 units x the latest NAV), folio F2 at 52000; each XIRR equals its own independent oracle', async () => {
    const client = clientFor(buildTables(USER, [s1()]));
    const l1 = await buildTransactionLedger(client, USER, 'acc-a1', 'inst-s1');
    const l2 = await buildTransactionLedger(client, USER, 'acc-a2', 'inst-s1');
    expect(l1!.terminal).toEqual({ date: '2026-09-25', description: 'Closing market value', amount: 78000 });
    expect(l2!.terminal).toEqual({ date: '2026-09-25', description: 'Closing market value', amount: 52000 });
    expect(rate(l1!.investorXirr)).toBeCloseTo(oracleXirr([['2025-01-10', -60000], ['2026-09-25', 78000]]), 6);
    expect(rate(l2!.investorXirr)).toBeCloseTo(oracleXirr([['2025-06-10', -40000], ['2026-09-25', 52000]]), 6);
    // ... and they are the numbers the Holdings rows show.
    const holdings = await loadHoldingsTable(client, USER);
    expect(rate(holdings.holdings.find((h) => h.accountId === 'acc-a1')!.xirr)).toBeCloseTo(rate(l1!.investorXirr), 9);
    expect(rate(holdings.holdings.find((h) => h.accountId === 'acc-a2')!.xirr)).toBeCloseTo(rate(l2!.investorXirr), 9);
  });

  it('with no newer NAV and no later units the ledger still closes on the statement value at the statement date (unchanged)', async () => {
    const spec = s1();
    spec.navs = [{ date: '2026-06-30', price: 110 }];
    const l1 = await buildTransactionLedger(clientFor(buildTables(USER, [spec])), USER, 'acc-a1', 'inst-s1');
    expect(l1!.terminal).toEqual({ date: '2026-06-30', description: 'Closing market value', amount: 66000 });
  });
});
