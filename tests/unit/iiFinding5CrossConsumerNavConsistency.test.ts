// Document2 Finding #5 ("Current NAV / holding value") — CROSS-CONSUMER
// consistency. Every Investment Intelligence screen that shows a current
// holding value must show the SAME value, dated by the SAME NAV, for the same
// holding:
//
//   Holdings table        loadHoldingsTable()      (marketValue / nav / navDate)
//   Performance           loadAnalyticsDataset()   (scheme.currentValue / currentValueDate)
//   X-Ray                 loadXrayDataset()        (positions[].value / portfolioAsOfDate)
//   Overview              buildOverviewSummary()   (valueByCurrency / latestAsOfDate)
//   Report data           loadXrayForReport()      (lookThrough.totalPortfolioValue / AMC bucket)
//   SIP closing value     loadSipDataset()         (the NAV the SIP engine would value the position at)
//
// Portfolio Truth PUBLICATION is intentionally NOT in that list: a publication
// freezes the value CERTIFIED at the statement date (see the contract test at
// the bottom, and the closure report for the disclosed decision).
//
// The tests drive the REAL repositories against a filtering in-memory Supabase
// double (eq / in / is / gte / lte / order / range / head-count are honoured —
// the shared fakeSupabaseClient treats gte/lte as no-ops and so cannot prove a
// date bound). Time is pinned with fake timers so "today" is 2026-09-28.
//
// Hand-computed expectations (INR holding, 100 units, statement 2026-06-30
// value 10000, i.e. statement NAV 100, cost 9500):
//   NAV 2026-09-25 @ 120 (latest eligible) -> 100 x 120 = 12000
//   an AUD NAV 2026-09-26 @ 50, a 'stale'-flagged NAV 2026-09-27 @ 135 and a
//   future NAV 2026-10-05 @ 999 must all be ignored.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadHoldingsTable } from '@/lib/services/investment-intelligence/holdingsRepository';
import { loadAnalyticsDataset } from '@/lib/services/investment-intelligence/analyticsRepository';
import { loadSipDataset, loadXrayDataset } from '@/lib/services/investment-intelligence/r5Repository';
import { resolveObservationAsOf, sortSeries } from '@/lib/engines/investment-intelligence/sip/dateAlignment';
import { buildOverviewSummary } from '@/lib/services/investment-intelligence/overviewSummary';
import { loadXrayForReport } from '@/lib/services/investmentIntelligenceReportData';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// A filtering Supabase double.
// ---------------------------------------------------------------------------
function makeClient(tables: Record<string, Row[]>): SupabaseClient {
  function builderFor(table: string) {
    let rows = [...(tables[table] ?? [])];
    const order: Array<{ col: string; asc: boolean }> = [];
    let head = false;
    let limitN: number | null = null;
    const sorted = () => {
      const out = [...rows];
      for (let i = order.length - 1; i >= 0; i--) {
        const { col, asc } = order[i];
        out.sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ? 1 : -1;
          return 0;
        });
      }
      return out;
    };
    const b: Record<string, unknown> = {
      select(_cols?: string, opts?: { head?: boolean }) {
        if (opts?.head) head = true;
        return b;
      },
      eq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] === val);
        return b;
      },
      neq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] !== val);
        return b;
      },
      in(col: string, vals: unknown[]) {
        const set = new Set(vals);
        rows = rows.filter((r) => set.has(r[col]));
        return b;
      },
      is(col: string, val: unknown) {
        rows = rows.filter((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return b;
      },
      gte(col: string, val: string) {
        rows = rows.filter((r) => (r[col] as string) >= val);
        return b;
      },
      lte(col: string, val: string) {
        rows = rows.filter((r) => (r[col] as string) <= val);
        return b;
      },
      gt(col: string, val: string) {
        rows = rows.filter((r) => (r[col] as string) > val);
        return b;
      },
      lt(col: string, val: string) {
        rows = rows.filter((r) => (r[col] as string) < val);
        return b;
      },
      not() {
        return b;
      },
      or() {
        return b;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        order.push({ col, asc: opts?.ascending !== false });
        return b;
      },
      limit(n: number) {
        limitN = n;
        return b;
      },
      range(from: number, to: number) {
        return Promise.resolve({ data: sorted().slice(from, to + 1), error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: sorted()[0] ?? null, error: null });
      },
      single() {
        const r = sorted()[0];
        return Promise.resolve({ data: r ?? null, error: r ? null : { message: 'no row' } });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        const out = sorted();
        const result = head ? { data: null, count: out.length, error: null } : { data: limitN === null ? out.slice(0, 1000) : out.slice(0, limitN), error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return b;
  }
  return { from: (t: string) => builderFor(t) } as unknown as SupabaseClient;
}

const USER = 'user-f5';
const ACCOUNT = 'acc-1';
const INST = 'inst-1';

interface Scenario {
  units: number;
  value: number;
  statementDate?: string;
  navs: Array<{ date: string; price: number; currency?: string; quality?: string }>;
  extraSnapshots?: Row[];
}

function tablesFor(sc: Scenario): Record<string, Row[]> {
  const stmtDate = sc.statementDate ?? '2026-06-30';
  return {
    ii_portfolio_truth_status: [
      { id: 't1', user_id: USER, account_id: ACCOUNT, instrument_id: INST, status: 'certified', unit_variance_within_tolerance: true, latest_source_document_id: 'doc-1', history_completeness: 'complete_from_inception' },
    ],
    ii_transactions: [
      { id: 'tx1', user_id: USER, account_id: ACCOUNT, instrument_id: INST, transaction_type: 'purchase', transaction_date: '2026-01-05', gross_amount: 9500, units: 100, currency_code: 'INR', status: 'parsed' },
    ],
    ii_holding_snapshots: [
      { id: 's1', user_id: USER, account_id: ACCOUNT, instrument_id: INST, as_of_date: stmtDate, units: sc.units, value: sc.value, currency_code: 'INR', quality_status: 'certified', source_document_id: 'doc-1' },
      ...(sc.extraSnapshots ?? []),
    ],
    ii_instruments: [{ id: INST, instrument_name: 'Alpha Flexi Cap Fund', base_currency: 'INR', country_of_domicile: 'IN', isin: 'INF000000001', instrument_class: 'mutual_fund' }],
    ii_accounts: [{ id: ACCOUNT, user_id: USER, folio_number: 'FOLIO-1', institution_name: 'Alpha AMC', currency_code: 'INR' }],
    ii_source_documents: [{ id: 'doc-1', user_id: USER, source_detected: 'cams', status: 'processed' }],
    ii_scheme_master: [{ instrument_id: INST, scheme_name: 'Alpha Flexi Cap Fund - Direct', amc_name: 'Alpha AMC', effective_to: null }],
    ii_prices_nav: sc.navs.map((n, i) => ({
      id: `nav-${i}`,
      instrument_id: INST,
      price_date: n.date,
      price: n.price,
      currency_code: n.currency ?? 'INR',
      quality_status: n.quality ?? 'ok',
      data_version: 'v1',
    })),
  };
}

// The NAV set that exercises every exclusion rule at once.
const RICH_NAVS: Scenario['navs'] = [
  { date: '2026-06-30', price: 100 },
  { date: '2026-08-15', price: 110 },
  { date: '2026-09-25', price: 120 }, // <- the latest ELIGIBLE NAV
  { date: '2026-09-26', price: 50, currency: 'AUD' }, // wrong currency
  { date: '2026-09-27', price: 135, quality: 'stale' }, // flagged
  { date: '2026-10-05', price: 999 }, // future-dated
];

interface Observed {
  holdingsValue: number | null;
  holdingsNav: number | null;
  holdingsNavDate: string | null;
  holdingsBasis: string;
  performanceValue: number;
  performanceDate: string;
  xrayValue: number;
  xrayPortfolioAsOf: string;
  overviewValue: number;
  overviewLatestDate: string | null;
  reportTotal: number | null;
}

async function observe(sc: Scenario): Promise<{ obs: Observed; client: SupabaseClient; all: Awaited<ReturnType<typeof loadHoldingsTable>>; xrayWarnings: Array<{ scope: string; detail: string }>; overview: Awaited<ReturnType<typeof buildOverviewSummary>> }> {
  const client = makeClient(tablesFor(sc));
  const holdings = await loadHoldingsTable(client, USER);
  const h = holdings.holdings[0];
  const analytics = await loadAnalyticsDataset(client, USER);
  const scheme = analytics.dataset!.schemes[0];
  const xray = await loadXrayDataset(client, USER);
  const overview = await buildOverviewSummary(client, USER);
  const report = await loadXrayForReport(USER, client as never);
  return {
    client,
    all: holdings,
    xrayWarnings: xray.warnings,
    overview,
    obs: {
      holdingsValue: h.marketValue,
      holdingsNav: h.nav,
      holdingsNavDate: h.navDate,
      holdingsBasis: h.valuationBasis,
      performanceValue: scheme.currentValue,
      performanceDate: scheme.currentValueDate.toISOString().slice(0, 10),
      xrayValue: xray.dataset!.positions[0].value,
      xrayPortfolioAsOf: xray.dataset!.portfolioAsOfDate,
      overviewValue: overview.portfolio.valueByCurrency[0].totalValue,
      overviewLatestDate: overview.portfolio.latestAsOfDate,
      reportTotal: report ? report.results.lookThrough.totalPortfolioValue : null,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Finding #5 cross-consumer: a newer eligible NAV exists (100 units, statement 2026-06-30 @100, latest eligible NAV 2026-09-25 @120)', () => {
  it('Holdings, Performance, X-Ray, Overview and Report data all show 12000 dated 2026-09-25', async () => {
    const { obs, all } = await observe({ units: 100, value: 10000, navs: RICH_NAVS });

    // Holdings table
    expect(obs.holdingsValue).toBe(12000);
    expect(obs.holdingsNav).toBe(120);
    expect(obs.holdingsNavDate).toBe('2026-09-25');
    expect(obs.holdingsBasis).toBe('market_nav');
    // Performance
    expect(obs.performanceValue).toBe(12000);
    expect(obs.performanceDate).toBe('2026-09-25');
    // X-Ray (and the "Positions as at" date it shows)
    expect(obs.xrayValue).toBe(12000);
    expect(obs.xrayPortfolioAsOf).toBe('2026-09-25');
    // Overview
    expect(obs.overviewValue).toBe(12000);
    expect(obs.overviewLatestDate).toBe('2026-09-25');
    // Report data (built from the same X-Ray loader)
    expect(obs.reportTotal).toBe(12000);

    // The Holdings row keeps the statement NAV as EVIDENCE only.
    const h = all.holdings[0];
    expect(h.statementSuperseded).toBe(true);
    expect(h.statementNav).toBe(100);
    expect(h.statementAsOfDate).toBe('2026-06-30');
    expect(h.navSource).toBe('market');
    // Gain/loss is computed against the value actually displayed: 12000 - 9500.
    expect(h.costValue).toBe(9500);
    expect(h.gainLoss).toBe(2500);
    expect(h.returnPct).toBeCloseTo(2500 / 9500, 10);
    // 3 days old: not stale.
    expect(h.valuationStale).toBe(false);
  });

  it('every consumer ignored the wrong-currency, flagged and future-dated NAVs (a single agreed value, not five different ones)', async () => {
    const { obs } = await observe({ units: 100, value: 10000, navs: RICH_NAVS });
    const values = new Set([obs.holdingsValue, obs.performanceValue, obs.xrayValue, obs.overviewValue, obs.reportTotal]);
    expect([...values]).toEqual([12000]);
    const dates = new Set([obs.holdingsNavDate, obs.performanceDate, obs.xrayPortfolioAsOf, obs.overviewLatestDate]);
    expect([...dates]).toEqual(['2026-09-25']);
  });

  it('NEGATIVE CONTROL (data): remove the newer NAV and every consumer falls back to the labelled statement value 10000 dated 2026-06-30 — proving the 12000 above came from the NAV, not from a constant', async () => {
    const { obs, all } = await observe({ units: 100, value: 10000, navs: [{ date: '2026-06-30', price: 100 }] });
    expect(obs.holdingsValue).toBe(10000);
    expect(obs.performanceValue).toBe(10000);
    expect(obs.xrayValue).toBe(10000);
    expect(obs.overviewValue).toBe(10000);
    expect(obs.reportTotal).toBe(10000);
    expect(obs.holdingsBasis).toBe('statement');
    expect(obs.holdingsNavDate).toBe('2026-06-30');
    expect(all.holdings[0].navSource).toBe('statement');
    expect(all.holdings[0].statementSuperseded).toBe(false);
  });

  it('NEGATIVE CONTROL (guards): if ONLY ineligible NAVs are newer (wrong currency, flagged, future), every consumer still shows the statement value — each guard is individually load-bearing', async () => {
    for (const bad of [
      { date: '2026-09-26', price: 50, currency: 'AUD' },
      { date: '2026-09-27', price: 135, quality: 'stale' },
      { date: '2026-09-27', price: 135, quality: 'suspicious_jump' },
      { date: '2026-10-05', price: 999 },
      { date: '2026-09-26', price: 0 },
    ]) {
      const { obs } = await observe({ units: 100, value: 10000, navs: [{ date: '2026-06-30', price: 100 }, bad] });
      expect([obs.holdingsValue, obs.performanceValue, obs.xrayValue, obs.overviewValue, obs.reportTotal], JSON.stringify(bad)).toEqual([10000, 10000, 10000, 10000, 10000]);
    }
  });
});

describe('Finding #5 cross-consumer: the SIP closing-value NAV follows the same eligibility', () => {
  it('SIP never sees the wrong-currency or flagged NAVs, and resolves the same 2026-09-25 @120 NAV the other consumers use', async () => {
    const client = makeClient(tablesFor({ units: 100, value: 10000, navs: RICH_NAVS }));
    const { dataset } = await loadSipDataset(client, USER, { asOfDate: '2026-09-28' });
    const series = dataset!.navByInstrument.get(INST)!;
    // 2026-09-26 @50 (AUD) and 2026-09-27 @135 ('stale') were dropped at load.
    expect(series.map((o) => o.date)).not.toContain('2026-09-26');
    expect(series.map((o) => o.date)).not.toContain('2026-09-27');
    const used = resolveObservationAsOf(sortSeries(series), '2026-09-28');
    expect(used.status).toBe('ok');
    expect(used.observation).toMatchObject({ date: '2026-09-25', value: 120 });
  });

  it('NEGATIVE CONTROL: the pre-fix SIP rule (exclude only "superseded") WOULD have picked a flagged or foreign-currency NAV — proven by replaying that rule on the same rows', () => {
    const rows = RICH_NAVS.map((n) => ({ date: n.date, value: n.price, quality: n.quality ?? 'ok', currency: n.currency ?? 'INR' }));
    const oldRuleSeries = rows.filter((r) => r.quality !== 'superseded' && r.date <= '2026-09-28').map((r) => ({ date: r.date, value: r.value }));
    const oldUsed = resolveObservationAsOf(sortSeries(oldRuleSeries), '2026-09-28');
    expect(oldUsed.observation).toMatchObject({ date: '2026-09-27', value: 135 }); // the flagged NAV the old rule would have used
    expect(oldUsed.observation?.value).not.toBe(120);
  });
});

describe('Finding #5 cross-consumer: redeemed holding (0 units) needs no NAV', () => {
  it('is exactly 0 everywhere, with or without a later NAV, and is labelled Redeemed', async () => {
    for (const navs of [[], [{ date: '2026-08-29', price: 15 }]]) {
      const { obs, all } = await observe({ units: 0, value: 0, statementDate: '2026-07-20', navs });
      expect(obs.holdingsValue).toBe(0);
      expect(obs.performanceValue).toBe(0);
      expect(obs.xrayValue).toBe(0);
      expect(obs.overviewValue).toBe(0);
      expect(all.holdings[0].valuationBasis).toBe('redeemed');
      expect(all.holdings[0].nav).toBeNull();
      expect(all.holdings[0].unitBalance).toBe(0);
    }
  });
});

describe('Finding #5 cross-consumer: stale-NAV disclosure', () => {
  it('a latest NAV 18 days old is still used but disclosed as stale by Holdings, Overview and X-Ray (never presented as current, never a fake zero)', async () => {
    const { obs, all, overview, xrayWarnings } = await observe({ units: 100, value: 10000, navs: [{ date: '2026-06-30', price: 100 }, { date: '2026-09-10', price: 115 }] });
    expect(obs.holdingsValue).toBe(11500);
    expect(obs.holdingsNavDate).toBe('2026-09-10');
    expect(all.holdings[0].valuationStale).toBe(true);
    expect(all.holdings[0].valuationNote).toMatch(/may be out of date/);
    expect(overview.portfolio.valuation.staleCount).toBe(1);
    expect(xrayWarnings.some((w) => w.scope === 'valuation' && /more than 7 days old/.test(w.detail))).toBe(true);
    // Performance and X-Ray still agree on the value despite the staleness.
    expect(obs.performanceValue).toBe(11500);
    expect(obs.xrayValue).toBe(11500);
  });

  it('with no market NAV at all and an old statement the value is the labelled statement value, flagged stale — not 0, not null', async () => {
    const { obs, all, overview } = await observe({ units: 100, value: 10000, navs: [] });
    expect(obs.holdingsValue).toBe(10000);
    expect(all.holdings[0].valuationBasis).toBe('statement');
    expect(all.holdings[0].valuationStale).toBe(true);
    expect(overview.portfolio.valuation).toMatchObject({ statementBasisCount: 1, marketNavCount: 0, staleCount: 1 });
  });

  it('a fresh NAV (3 days old) carries no stale flag anywhere', async () => {
    const { all, overview, xrayWarnings } = await observe({ units: 100, value: 10000, navs: [{ date: '2026-06-30', price: 100 }, { date: '2026-09-25', price: 120 }] });
    expect(all.holdings[0].valuationStale).toBe(false);
    expect(overview.portfolio.valuation.staleCount).toBe(0);
    expect(xrayWarnings.some((w) => w.scope === 'valuation')).toBe(false);
  });
});

describe('Finding #5 cross-consumer: a NAV correction (in-place update, one row per instrument/date) is what every consumer reads', () => {
  it('post-correction 105 -> 10500 everywhere; pre-correction 98 -> 9800 everywhere (so the consumers really read the stored value)', async () => {
    const post = await observe({ units: 100, value: 10000, navs: [{ date: '2026-09-20', price: 105 }] });
    expect([post.obs.holdingsValue, post.obs.performanceValue, post.obs.xrayValue, post.obs.overviewValue, post.obs.reportTotal]).toEqual([10500, 10500, 10500, 10500, 10500]);
    const pre = await observe({ units: 100, value: 10000, navs: [{ date: '2026-09-20', price: 98 }] });
    expect([pre.obs.holdingsValue, pre.obs.performanceValue, pre.obs.xrayValue, pre.obs.overviewValue, pre.obs.reportTotal]).toEqual([9800, 9800, 9800, 9800, 9800]);
  });
});

describe('Finding #5: historical / point-in-time views never use today’s NAV or a later statement', () => {
  const pitScenario: Scenario = {
    units: 100,
    value: 10000,
    statementDate: '2026-06-30',
    extraSnapshots: [
      { id: 's2', user_id: USER, account_id: ACCOUNT, instrument_id: INST, as_of_date: '2026-09-15', units: 120, value: 14400, currency_code: 'INR', quality_status: 'certified', source_document_id: 'doc-1' },
    ],
    navs: [
      { date: '2026-06-30', price: 100 },
      { date: '2026-08-15', price: 110 },
      { date: '2026-09-15', price: 120 },
      { date: '2026-09-25', price: 125 },
    ],
  };

  it('Performance as at 2026-08-20 values 100 units x the 2026-08-15 NAV (110) = 11000, not the later statement or today’s NAV', async () => {
    const client = makeClient(tablesFor(pitScenario));
    const { dataset } = await loadAnalyticsDataset(client, USER, { asOfDate: new Date('2026-08-20T00:00:00.000Z') });
    const scheme = dataset!.schemes[0];
    expect(scheme.currentValue).toBe(11000);
    expect(scheme.currentValueDate.toISOString().slice(0, 10)).toBe('2026-08-15');
  });

  it('X-Ray as at 2026-08-20 agrees with Performance as at 2026-08-20 (11000, dated 2026-08-15)', async () => {
    const client = makeClient(tablesFor(pitScenario));
    const { dataset } = await loadXrayDataset(client, USER, { asOfDate: '2026-08-20' });
    expect(dataset!.positions[0].value).toBe(11000);
    expect(dataset!.portfolioAsOfDate).toBe('2026-08-15');
  });

  it('the same data viewed TODAY (2026-09-28) uses the later statement and the latest NAV: 120 units x 125 = 15000, dated 2026-09-25 — everywhere', async () => {
    const client = makeClient(tablesFor(pitScenario));
    const h = (await loadHoldingsTable(client, USER)).holdings[0];
    const { dataset } = await loadAnalyticsDataset(client, USER);
    const x = await loadXrayDataset(client, USER);
    const o = await buildOverviewSummary(client, USER);
    expect(h.marketValue).toBe(15000);
    expect(h.navDate).toBe('2026-09-25');
    expect(dataset!.schemes[0].currentValue).toBe(15000);
    expect(x.dataset!.positions[0].value).toBe(15000);
    expect(o.portfolio.valueByCurrency[0].totalValue).toBe(15000);
  });

  it('NEGATIVE CONTROL: an as-of date BEFORE any statement leaves Performance with no current value (0) and X-Ray with no position — never a later statement back-filled', async () => {
    const client = makeClient(tablesFor(pitScenario));
    const { dataset } = await loadAnalyticsDataset(client, USER, { asOfDate: new Date('2026-05-01T00:00:00.000Z') });
    expect(dataset!.schemes[0].currentValue).toBe(0);
    const x = await loadXrayDataset(client, USER, { asOfDate: '2026-05-01' });
    expect(x.empty).toBe(true);
  });
});

describe('Finding #5: Portfolio Truth publication freezes the CERTIFIED statement valuation (explicit, bounded behaviour)', () => {
  const src = readFileSync(path.join(process.cwd(), 'lib/services/investment-intelligence/investmentPublicationService.ts'), 'utf8');

  it('publishes snapshot.value (the certified statement value) and records the statement date as the valuation date', () => {
    expect(src).toContain('current_value: snapshot.value');
    expect(src).toContain('published_value: snapshot.value');
    expect(src).toContain('valuationAsOfDate: snapshot.as_of_date');
  });

  it('never reads ii_prices_nav, so a publication can never silently drift with a daily NAV (idempotency / "exactly once" depends on this)', () => {
    expect(src).not.toContain('ii_prices_nav');
  });
});
