// Print fixtures for the Fund analytics PDF layout: a SYNTHETIC report of N funds made by the REAL report engine (buildFundAnalyticsReport), so
// the layout is judged on the same structure, number of tables and size of data a live report has (a 13-year price history per fund, rolling
// windows, risk measures, trend, the user's own money, rankings and correlations). No data of any real person or fund is used: names are
// invented, prices are a seeded random walk.
//
//   npx tsx scripts/nav2_print_fixtures.ts <name> [--out file.json]      name = funds-N, with optional +flags: unavailable, redeemed, long, young, longnames
//   e.g.  funds-12+unavailable+redeemed+long
//
// Exports buildPrintFixture(), also used by the unit tests and the layout check (timings are returned so the 25-fund build time is on record).
import { writeFileSync } from 'node:fs';
import { NAV2_POLICY } from '../lib/config/nav2/metricPolicy';
import { RISK_FREE_MAX_STALENESS_DAYS } from '../lib/config/nav2/metricPolicy';
import { RISK_FREE_SERIES } from '../lib/config/nav2/riskFreeSeriesConfig';
import { reportAnalysisSpec } from '../lib/engines/nav2/analysisSpec';
import { buildFundAnalyticsReport, type FundAnalyticsInput, type FundAnalyticsReport, type HeldSchemeInput } from '../lib/engines/nav2/fundAnalyticsReport';
import type { RiskFreeDataset, RiskFreeObservation } from '../lib/engines/nav2/riskFree';
import { prepareSeries } from '../lib/engines/nav2/series';

export const PRINT_FIXTURE_AS_OF = '2026-10-01';

const AMCS = ['Aster', 'Birch', 'Cedar', 'Dune', 'Elm', 'Fjord', 'Grove', 'Harbor', 'Iris', 'Juniper', 'Kestrel', 'Lumen'];
const CATS = [
  { key: 'large_cap', label: 'Large Cap' },
  { key: 'flexi_cap', label: 'Flexi Cap' },
  { key: 'mid_cap', label: 'Mid Cap' },
  { key: 'corporate_bond', label: 'Corporate Bond' },
  { key: 'gilt', label: 'Gilt' },
  { key: 'elss', label: 'ELSS' },
];

const PO_CATS = [
  { key: 'large_cap', label: 'Large Cap' },
  { key: 'large_cap', label: 'Large Cap' },
  { key: 'large_cap', label: 'Large Cap' },
  { key: 'flexi_cap', label: 'Flexi Cap' },
  { key: 'mid_cap', label: 'Mid Cap' },
  { key: 'corporate_bond', label: 'Corporate Bond' },
  { key: 'gilt', label: 'Gilt' },
  { key: 'elss', label: 'ELSS' },
  { key: 'small_cap', label: 'Small Cap' },
  { key: 'hybrid', label: 'Hybrid' },
];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weekdaysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${start}T00:00:00.000Z`);
  const stop = new Date(`${end}T00:00:00.000Z`).getTime();
  while (cur.getTime() <= stop) {
    const d = cur.getUTCDay();
    if (d !== 0 && d !== 6) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function riskFree(): RiskFreeDataset {
  const observations: RiskFreeObservation[] = [];
  const cur = new Date('2012-12-31T00:00:00.000Z');
  while (cur.toISOString().slice(0, 10) <= PRINT_FIXTURE_AS_OF) {
    observations.push({ observationDate: cur.toISOString().slice(0, 10), yieldPercent: 6.2, sourceDocument: 'SYNTHETIC TEST FIXTURE (not RBI data)', sourceUrl: null, retrievedOn: '2026-10-03' });
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return {
    seriesId: 'RBI_91D_TBILL_CUTOFF_YIELD',
    seriesName: RISK_FREE_SERIES.RBI_91D_TBILL_CUTOFF_YIELD.name,
    source: 'Reserve Bank of India',
    attributionText: 'Source: Reserve Bank of India',
    cadence: 'weekly_auction',
    datasetVersion: 'print-fixture-v1',
    retrievedOn: '2026-10-03',
    termsReviewStatus: 'po_accepted_2026-10-03',
    enabled: true,
    yieldBasis: 'annualised_percent_as_published',
    conversion: 'compound_per_period_1_over_n',
    observationSemantics: 'latest_on_or_before_never_future_never_interpolated',
    maxStalenessDays: RISK_FREE_MAX_STALENESS_DAYS.RBI_91D_TBILL_CUTOFF_YIELD,
    verifiedThroughDate: null,
    observations,
  };
}

export interface PrintFixtureOptions {
  funds: number;
  /** One fund (the last but one) with a short price history, no category and no matched holding: most metrics are unavailable. */
  unavailable?: boolean;
  /** One fund (the second) fully redeemed. */
  redeemed?: boolean;
  /** One fund (the first) with a very long name. */
  longName?: boolean;
  /** One fund (the third) with about two years of history: 3-year and 5-year figures are unavailable (the common real case). */
  young?: boolean;
  /** EVERY fund has a long production-style name (a code, the plan, a "formerly" clause, "(Non-Demat)"), as in the Product Owner's 10-fund production report of 19-10-2026. */
  longNames?: boolean;
}

export function parseFixtureName(name: string): PrintFixtureOptions {
  const [head, ...flags] = name.split('+');
  const m = /^funds-(\d+)$/.exec(head);
  if (!m) throw new Error(`unknown print fixture "${name}" (expected funds-N[+unavailable][+redeemed][+long][+young][+longnames])`);
  return { funds: Number(m[1]), unavailable: flags.includes('unavailable'), redeemed: flags.includes('redeemed'), longName: flags.includes('long'), young: flags.includes('young'), longNames: flags.includes('longnames') };
}

export interface PrintFixture {
  report: FundAnalyticsReport;
  manifest: unknown;
  timings: { seriesMs: number; reportMs: number; reportJsonBytes: number; manifestJsonBytes: number };
}

export function buildPrintFixture(opts: PrintFixtureOptions): PrintFixture {
  const t0 = performance.now();
  const dates = weekdaysBetween('2013-01-01', PRINT_FIXTURE_AS_OF);
  const schemes: HeldSchemeInput[] = [];
  for (let i = 0; i < opts.funds; i++) {
    // longnames = the Product Owner's 10-fund production report: three funds of one category (the only ranked ones) and seven with no peer
    const cat = opts.longNames ? PO_CATS[i % PO_CATS.length] : CATS[(i + Math.floor(i / 12)) % 6];
    const isUnavailable = !!opts.unavailable && opts.funds > 1 && i === Math.max(0, opts.funds - 2);
    const isRedeemed = !!opts.redeemed && opts.funds > 1 && i === 1;
    const long = !!opts.longName && i === 0;
    const id = `fixture-fund-${String(i + 1).padStart(2, '0')}`;
    const production = !!opts.longNames;
    const name = production
      ? `${['128EFGPG', 'B92', 'FTI036', 'FTI037', 'H02', 'H44', 'K123', 'L036G', 'L101G', 'P2373'][i % 10]}-${AMCS[i % 12]} ${cat.label} Fund${i % 3 === 0 ? ' - Regular Plan' : ''} - Growth${i % 2 === 0 ? ` (formerly known as ${AMCS[(i + 3) % 12]} Frontline Equity Fund)` : ''} (Non-Demat)`
      : long
      ? `${AMCS[i % 12]} Diversified Equity and Debt Hybrid Opportunities Allocation Fund - Direct Plan - Growth Option (formerly the ${AMCS[(i + 3) % 12]} Balanced Advantage Fund)`
      : `${AMCS[i % 12]} ${cat.label} Fund`;
    const isYoung = !!opts.young && i === Math.min(2, opts.funds - 1);
    const rows = isUnavailable ? dates.slice(-55) : isYoung ? dates.slice(-520) : dates.slice(i % 3 === 2 && i > 2 ? 700 : 0);
    const rand = rng(1000 + i * 7919);
    let nav = 10 + rand() * 40;
    const drift = 0.00018 + (i % 5) * 0.00006;
    const vol = (cat.key === 'corporate_bond' || cat.key === 'gilt' ? 0.0018 : 0.009) + (i % 4) * 0.0008;
    const navs = rows.map(() => {
      nav *= 1 + drift + vol * (rand() + rand() + rand() - 1.5) * 1.6;
      return Math.round(nav * 10000) / 10000;
    });
    const series = prepareSeries(
      {
        identity: { instrumentId: id, currency: 'INR', planType: 'direct', optionType: 'growth', resolved: true, schemeName: name },
        asOfDate: PRINT_FIXTURE_AS_OF,
        rows: rows.map((priceDate, k) => ({ id: `${id}-${priceDate}`, instrumentId: id, priceDate, price: navs[k], currencyCode: 'INR' })),
      },
      NAV2_POLICY
    );
    const lastNav = navs[navs.length - 1];
    const firstHeld = isUnavailable ? rows[Math.min(10, rows.length - 1)] : rows[Math.min(Math.floor(rows.length * 0.6), 900 + i * 17)];
    const units = 100 + i * 13;
    const invested = Math.round(units * navs[rows.indexOf(firstHeld)] * 100) / 100;
    const investor = isUnavailable
      ? null
      : isRedeemed
        ? {
            instrumentId: id,
            flows: [
              { date: new Date(`${firstHeld}T00:00:00.000Z`), amount: -invested },
              { date: new Date('2026-03-02T00:00:00.000Z'), amount: Math.round(invested * 1.18 * 100) / 100 },
            ],
            valuation: { basis: 'redeemed' as const, units: 0, marketValue: 0, valuationDate: PRINT_FIXTURE_AS_OF, stale: false, nav: lastNav, navDate: rows[rows.length - 1] },
            asOfDate: PRINT_FIXTURE_AS_OF,
          }
        : {
            instrumentId: id,
            flows: [{ date: new Date(`${firstHeld}T00:00:00.000Z`), amount: -invested }],
            valuation: { basis: 'market_nav' as const, units, marketValue: Math.round(units * lastNav * 100) / 100, valuationDate: PRINT_FIXTURE_AS_OF, stale: false, nav: lastNav, navDate: rows[rows.length - 1] },
            asOfDate: PRINT_FIXTURE_AS_OF,
          };
    schemes.push({
      instrumentId: id,
      schemeName: name,
      planType: 'direct',
      optionType: 'growth',
      category: isUnavailable ? null : cat.key,
      categoryLabel: isUnavailable ? null : cat.label,
      series,
      benchmarks: [],
      investor,
      firstHeldDate: firstHeld,
    });
  }
  const seriesMs = performance.now() - t0;
  const input: FundAnalyticsInput = {
    asOfDate: PRINT_FIXTURE_AS_OF,
    displayCurrency: 'INR',
    policy: NAV2_POLICY,
    spec: reportAnalysisSpec(PRINT_FIXTURE_AS_OF, NAV2_POLICY, 'all_history'),
    periodChoice: 'all_history',
    riskFree: riskFree(),
    schemes,
    scope: { entityHeldSchemesExcluded: 0, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] },
    calculatedAt: '2026-10-07T10:15:30.000Z',
  };
  const t1 = performance.now();
  const { report, manifest } = buildFundAnalyticsReport(input);
  const reportMs = performance.now() - t1;
  return { report, manifest, timings: { seriesMs: Math.round(seriesMs), reportMs: Math.round(reportMs), reportJsonBytes: JSON.stringify(report).length, manifestJsonBytes: JSON.stringify(manifest).length } };
}

if (process.argv[1] && /nav2_print_fixtures\.(ts|js)$/.test(process.argv[1])) {
  const name = process.argv[2] ?? 'funds-4';
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  const { report, timings } = buildPrintFixture(parseFixtureName(name));
  console.log(name, JSON.stringify(timings));
  if (out) writeFileSync(out, JSON.stringify(report));
}
