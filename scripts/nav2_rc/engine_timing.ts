// NAV2 release candidate (B3): how long the REAL report service takes for 1, 4, 10 and 20 funds, cold (nothing cached) and warm (every fund cached),
// on this machine, with the database replaced by an in-memory one (so the figures are ENGINE plus service time, not database time). It is local evidence
// and the Product Owner has said not to infer production safety from it: the route against DEV is scripts/nav2_rc/dev_route_timing.mjs and
// production figures come only from the pilot (STOP GATE 2).
//
//   npx tsx scripts/nav2_rc/engine_timing.ts [--series-days 1600] [--repeats 3]
//
// Prints one table. Each cold figure is the median of `repeats` runs; each run uses a fresh cache. Nothing is written outside this process.
import { generateFundAnalyticsReport, type FundAnalyticsDeps } from '../../lib/services/investment-intelligence/nav2/fundAnalyticsReportService';
import { NAV2_POLICY } from '../../lib/config/nav2/metricPolicy';
import { reportAnalysisSpec } from '../../lib/engines/nav2/analysisSpec';
import type { FundAnalyticsInput, HeldSchemeInput } from '../../lib/engines/nav2/fundAnalyticsReport';
import { ENGINE_MS_PER_UNCACHED_FUND, GENERATION_BUDGET_MS, REQUEST_DEADLINE_MS } from '../../lib/config/nav2/reportLimits';
import { prepareSeries } from '../../lib/engines/nav2/series';
import { createInMemoryDb } from '../../tests/unit/support/inMemorySupabase';
import type { SupabaseClient } from '@supabase/supabase-js';

const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const DAYS = arg('--series-days', 1600);
const REPEATS = arg('--repeats', 3);
const AS_OF = '2026-10-02';

function weekdays(end: string, n: number): string[] {
  const out: string[] = [];
  const cur = new Date(`${end}T00:00:00.000Z`);
  while (out.length < n) {
    if (cur.getUTCDay() !== 0 && cur.getUTCDay() !== 6) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() - 1);
  }
  return out.reverse();
}
const DATES = weekdays('2026-09-30', DAYS);
const idOf = (i: number) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
function navs(seed: number): number[] {
  const out = [100];
  for (let i = 1; i < DATES.length; i++) out.push(out[i - 1] * (1 + 0.0004 + 0.01 * Math.sin(i * 0.37 + seed) * Math.cos(i * 0.11 + seed * 2)));
  return out;
}
function scheme(i: number): HeldSchemeInput {
  const id = idOf(i);
  const name = `Timing Fund ${String(i + 1).padStart(2, '0')}`;
  const nav = navs(i + 1);
  const series = prepareSeries({ identity: { instrumentId: id, currency: 'INR', planType: 'direct', optionType: 'growth', resolved: true, schemeName: name }, asOfDate: AS_OF, rows: DATES.map((d, k) => ({ id: `${id}-${d}`, instrumentId: id, priceDate: d, price: nav[k], currencyCode: 'INR' })) }, NAV2_POLICY);
  return { instrumentId: id, schemeName: name, planType: 'direct', optionType: 'growth', category: 'flexi_cap', categoryLabel: 'Flexi Cap', series, benchmarks: [], investor: null, firstHeldDate: DATES[40] };
}
const inputFor = (n: number): FundAnalyticsInput => ({
  asOfDate: AS_OF, displayCurrency: 'INR', policy: NAV2_POLICY, spec: reportAnalysisSpec(AS_OF, NAV2_POLICY, 'since_first_held'), periodChoice: 'since_first_held', riskFree: null,
  schemes: Array.from({ length: n }, (_, i) => scheme(i)), scope: { entityHeldSchemesExcluded: 0, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] },
});
const openGate = { hold: false, funds: [], total: 1, loaded: 1, waiting: [], unavailable: [], heldSince: null, headline: null, disclosures: [] };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function run(n: number, db = createInMemoryDb({ strictSchema: true }), fresh = true) {
  if (fresh) db.reset({ nav2_fund_analytics_reports: [], nav2_report_nav_dependencies: [], nav2_result_cache: [], ii_reference_job_control: [] });
  const input = inputFor(n);
  const deps: Partial<FundAnalyticsDeps> = { isFlagOn: async () => true, isPremium: async () => true, gate: async () => openGate as never, load: async () => ({ input, warnings: [], riskFreeUnavailableReason: null }), nowIso: () => new Date().toISOString(), nowMs: () => 0 };
  const t0 = performance.now();
  // the admission clock is frozen at zero so the TIMING is of the whole job (the admission rule is tested elsewhere)
  const r = await generateFundAnalyticsReport({ userId: 'timing-user', sessionClient: db.client as never, adminClient: db.client as unknown as SupabaseClient, periodChoice: 'since_first_held', asOfDate: AS_OF, requestStartedMs: 0, deps });
  const ms = performance.now() - t0;
  const bytes = db.tables.nav2_fund_analytics_reports[0] ? JSON.stringify(db.tables.nav2_fund_analytics_reports[0].report_json).length : 0;
  return { ms, status: r.status, ready: r.status === 'in_steps' ? r.ready : null, db, bytes };
}

async function main() {
  console.log(`series: ${DAYS} daily observations per fund; engine admission budget ${GENERATION_BUDGET_MS} ms at ${ENGINE_MS_PER_UNCACHED_FUND} ms per uncached fund; hard deadline ${REQUEST_DEADLINE_MS} ms`);
  console.log('funds | cold ms (median of runs) | cold ms per fund | cold status | warm ms | warm status | report JSON MB');
  const perFund: number[] = [];
  for (const n of [1, 4, 10, 20]) {
    const colds: number[] = [];
    let status = '';
    let keepDb = createInMemoryDb({ strictSchema: true });
    let bytes = 0;
    for (let k = 0; k < REPEATS; k++) {
      const r = await run(n);
      colds.push(r.ms);
      status = r.status + (r.ready !== null ? `(${r.ready}/${n})` : '');
      keepDb = r.db;
      bytes = r.bytes;
    }
    // the budget may stop a cold run early (in steps); finish it so the warm run has every fund cached, then time a warm run
    let guard = 0;
    while (guard++ < 5) {
      const r = await run(n, keepDb, false);
      keepDb = r.db;
      if (r.status === 'ready') break;
    }
    const warm = await run(n, keepDb, false);
    const cold = median(colds);
    perFund.push(cold / n);
    console.log(`${String(n).padStart(5)} | ${cold.toFixed(0).padStart(9)} | ${(cold / n).toFixed(0).padStart(8)} | ${status.padEnd(12)} | ${warm.ms.toFixed(0).padStart(7)} | ${warm.status.padEnd(10)} | ${(bytes / 1048576).toFixed(2)}`);
  }
  console.log(`engine+service time per uncached fund on this machine: ${Math.min(...perFund).toFixed(0)} to ${Math.max(...perFund).toFixed(0)} ms (the admission estimate is ${ENGINE_MS_PER_UNCACHED_FUND} ms)`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
