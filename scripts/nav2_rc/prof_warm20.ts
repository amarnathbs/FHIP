// Profiling target: 20 funds, cold then warm, through the real service (in-memory database). Run with: node --cpu-prof --cpu-prof-dir=<dir> node_modules/tsx/dist/cli.mjs scripts/nav2_rc/prof_warm20.ts
import { generateFundAnalyticsReport, type FundAnalyticsDeps } from '../../lib/services/investment-intelligence/nav2/fundAnalyticsReportService';
import { NAV2_POLICY } from '../../lib/config/nav2/metricPolicy';
import { reportAnalysisSpec } from '../../lib/engines/nav2/analysisSpec';
import type { FundAnalyticsInput, HeldSchemeInput } from '../../lib/engines/nav2/fundAnalyticsReport';
import { prepareSeries } from '../../lib/engines/nav2/series';
import { createInMemoryDb } from '../../tests/unit/support/inMemorySupabase';
import type { SupabaseClient } from '@supabase/supabase-js';

const AS_OF = '2026-10-02';
const N = Number(process.argv[2] ?? 20);
const DAYS = 1600;
const dates: string[] = [];
const cur = new Date('2026-09-30T00:00:00.000Z');
while (dates.length < DAYS) { if (cur.getUTCDay() !== 0 && cur.getUTCDay() !== 6) dates.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() - 1); }
dates.reverse();
const idOf = (i: number) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
function scheme(i: number): HeldSchemeInput {
  const id = idOf(i);
  const nav: number[] = [100];
  for (let k = 1; k < dates.length; k++) nav.push(nav[k - 1] * (1 + 0.0004 + 0.01 * Math.sin(k * 0.37 + i) * Math.cos(k * 0.11 + i * 2)));
  const series = prepareSeries({ identity: { instrumentId: id, currency: 'INR', planType: 'direct', optionType: 'growth', resolved: true, schemeName: `F${i}` }, asOfDate: AS_OF, rows: dates.map((d, k) => ({ id: `${id}-${d}`, instrumentId: id, priceDate: d, price: nav[k], currencyCode: 'INR' })) }, NAV2_POLICY);
  return { instrumentId: id, schemeName: `Fund ${i}`, planType: 'direct', optionType: 'growth', category: 'flexi_cap', categoryLabel: 'Flexi Cap', series, benchmarks: [], investor: null, firstHeldDate: dates[40] };
}
async function main() {
  const input: FundAnalyticsInput = { asOfDate: AS_OF, displayCurrency: 'INR', policy: NAV2_POLICY, spec: reportAnalysisSpec(AS_OF, NAV2_POLICY, 'since_first_held'), periodChoice: 'since_first_held', riskFree: null, schemes: Array.from({ length: N }, (_, i) => scheme(i)), scope: { entityHeldSchemesExcluded: 0, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] } };
  const db = createInMemoryDb({ strictSchema: true });
  db.reset({ nav2_fund_analytics_reports: [], nav2_report_nav_dependencies: [], nav2_result_cache: [], ii_reference_job_control: [] });
  const deps: Partial<FundAnalyticsDeps> = { isFlagOn: async () => true, isPremium: async () => true, gate: async () => ({ hold: false, funds: [], total: 1, loaded: 1, waiting: [], unavailable: [], heldSince: null, headline: null, disclosures: [] }) as never, load: async () => ({ input, warnings: [], riskFreeUnavailableReason: null }), nowIso: () => new Date().toISOString(), nowMs: () => 0 };
  const go = (label: string) => generateFundAnalyticsReport({ userId: 'u', sessionClient: db.client as never, adminClient: db.client as unknown as SupabaseClient, periodChoice: 'since_first_held', asOfDate: AS_OF, requestStartedMs: 0, deps }).then((r) => console.log(label, r.status));
  let t = performance.now();
  for (let i = 0; i < 4; i++) { await go('cold pass ' + i); console.log('  ms', Math.round(performance.now() - t)); t = performance.now(); if (db.tables.nav2_fund_analytics_reports.length) break; }
  await go('WARM'); console.log('  WARM ms', Math.round(performance.now() - t));
}
main().catch((e) => { console.error(e); process.exit(1); });
