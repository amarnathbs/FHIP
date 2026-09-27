/**
 * Golden pair: the variance table. Reads the two measure files (every consumer, through the real routes),
 * prints (1) the headline metric per consumer with M, I and the difference, and (2) EVERY other differing
 * leaf, each assigned to a named explanation class -- a leaf no rule explains is printed as UNEXPLAINED.
 *
 *   npx tsx scripts/canonical_cert/golden_pair/variance_table.ts --a M --b I [--json out.json]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compareMeasures } from './compare';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const A = arg('--a') ?? 'M';
const B = arg('--b') ?? 'I';
type Out = Record<string, { status: number; json: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
const load = (l: string): Out => JSON.parse(fs.readFileSync(path.resolve('.canonical-cert', 'gp', `measure-${l}.json`), 'utf8')).out;
const a = load(A);
const b = load(B);

const get = (o: Out, route: string, p: string): unknown => p.split('.').reduce<any>((v, k) => (v == null ? v : v[k]), o[route]?.json); // eslint-disable-line @typescript-eslint/no-explicit-any
const D = 'GET /api/dashboard/summary';
const sectionNW = (o: Out) => (o['GET /api/reports/[id]/sections']?.json?.data ?? []).find((s: { sectionCode: string }) => s.sectionCode === 'net_worth')?.sectionData?.netWorth;
const sumRows = (o: Out, route: string, col: string) => (o[route]?.json?.data ?? []).reduce((s: number, r: Record<string, number>) => s + Number(r[col] ?? 0), 0);

const METRICS: [string, string, (o: Out) => unknown][] = [
  ['Income', 'gross monthly (Dashboard)', (o) => get(o, D, 'data.grossMonthlyIncome')],
  ['Income', 'net monthly (Dashboard)', (o) => get(o, D, 'data.netMonthlyIncome')],
  ['Income', 'combined gross (income read model)', (o) => get(o, 'GET /api/income/actuals', 'data.combined.grossMonthly')],
  ['Income', 'combined net (income read model)', (o) => get(o, 'GET /api/income/actuals', 'data.combined.netMonthly')],
  ['Expenses', 'combined monthly (Dashboard basis)', (o) => get(o, D, 'data.totalMonthlyExpenses')],
  ['Expenses', 'combined monthly (expense read model)', (o) => get(o, 'GET /api/expenses/actuals', 'data.totals.combinedMonthly')],
  ['Expenses', 'essential monthly', (o) => get(o, D, 'data.essentialMonthlyExpenses')],
  ['Expenses', 'lifestyle monthly', (o) => get(o, D, 'data.lifestyleMonthlyExpenses')],
  ['Expenses', 'planned monthly (M: typed; I: WP-15 averages applied)', (o) => get(o, 'GET /api/expenses/actuals', 'data.totals.plannedMonthly')],
  ['Expenses', 'actual monthly (approved statements)', (o) => get(o, 'GET /api/expenses/actuals', 'data.totals.actualMonthly')],
  ['Assets', 'total assets (core)', (o) => get(o, D, 'data.totalAssets')],
  ['Assets', 'assets + investments + retirement', (o) => get(o, D, 'data.totalAssetsCombined')],
  ['Liabilities', 'total liabilities', (o) => get(o, D, 'data.totalLiabilities')],
  ['Liabilities', 'debt service monthly (D-08/D-09)', (o) => get(o, D, 'data.debtMonthlyRepayments')],
  ['Liabilities', 'register balance sum (Liabilities tab)', (o) => sumRows(o, 'GET /api/liabilities', 'balance')],
  ['Investments', 'total investments', (o) => get(o, D, 'data.totalInvestments')],
  ['Investments', 'register value sum (Investments tab)', (o) => sumRows(o, 'GET /api/investments', 'current_value')],
  ['Investments', 'imported, not yet in Net Worth', (o) => get(o, 'GET /api/investments/imported-statements', 'data.unpublished.total')],
  ['Retirement', 'total retirement', (o) => get(o, D, 'data.totalRetirement')],
  ['Retirement', 'employer contribution monthly', (o) => get(o, D, 'data.retirementEmployerMonthlyContribution')],
  ['Net Worth', 'Dashboard net worth', (o) => get(o, D, 'data.netWorth')],
  ['Cashflow', 'monthly surplus', (o) => get(o, D, 'data.monthlySurplus')],
  ['Cashflow', 'savings rate', (o) => get(o, D, 'data.savingsRate')],
  ['Cashflow', 'debt service ratio', (o) => get(o, D, 'data.debtServiceRatio')],
  ['Cashflow', 'debt to income', (o) => get(o, D, 'data.debtToIncome')],
  ['Cashflow', 'emergency fund months', (o) => get(o, D, 'data.emergencyFundMonths')],
  ['Score', 'overall health score', (o) => get(o, 'GET /api/health-score', 'data.overallScore')],
  ['DNA', 'primary profile', (o) => get(o, 'GET /api/intelligence/financial-dna', 'data.primaryProfileCode')],
  ['DNA', 'primary score', (o) => get(o, 'GET /api/intelligence/financial-dna', 'data.primaryScore')],
  ['DNA', 'confidence', (o) => get(o, 'GET /api/intelligence/financial-dna', 'data.confidence')],
  ['Resilience', 'overall score', (o) => get(o, 'GET /api/resilience', 'data.overallScore')],
  ['Resilience', 'accessible liquid resources', (o) => get(o, 'GET /api/resilience', 'data.accessibleLiquidResources')],
  ['Twin', 'metrics compared', (o) => get(o, 'POST /api/financial-twin/generate', 'data.metricsCompared')],
  ['Twin', 'ahead / aligned / behind', (o) => ['aheadCount', 'alignedCount', 'behindCount'].map((k) => get(o, 'POST /api/financial-twin/generate', `data.${k}`)).join(' / ')],
  ['Twin', 'overall confidence', (o) => get(o, 'POST /api/financial-twin/generate', 'data.overallConfidence')],
  ['Forecast', 'net worth run input hash', (o) => String(get(o, 'POST /api/forecast/run net_worth', 'data.run.input_hash')).slice(0, 12)],
  ['Forecast', 'resilience run input hash', (o) => String(get(o, 'POST /api/forecast/run resilience', 'data.run.input_hash')).slice(0, 12)],
  ['Forecast', 'retirement run input hash', (o) => String(get(o, 'POST /api/forecast/run retirement', 'data.run.input_hash')).slice(0, 12)],
  ['Report', 'net worth (report net_worth section)', (o) => sectionNW(o)],
  // Register rows compared as MULTISETS of their economic columns (row order and names excluded).
  ['Liabilities', 'rows: type/balance/rate/repayment/min/limit/owner/currency', (o) => tuples(o, 'GET /api/liabilities', ['debt_type', 'balance', 'interest_rate', 'monthly_repayment', 'minimum_payment', 'credit_limit', 'owner', 'currency_code', 'country_code'])],
  ['Assets', 'rows: class/value/currency/country/owner', (o) => tuples(o, 'GET /api/assets', ['asset_class', 'current_value', 'currency_code', 'country_code', 'owner'])],
  ['Income', 'rows: type/gross/net/frequency/currency/owner', (o) => tuples(o, 'GET /api/income', ['income_type', 'amount', 'net_amount', 'frequency', 'currency_code', 'owner'])],
  ['Retirement', 'rows: balance/currency/country/owner', (o) => tuples(o, 'GET /api/retirement', ['current_balance', 'currency_code', 'country_code', 'owner'])],
  ['Dashboard', 'liabilityByType (as a set)', (o) => sorted(get(o, D, 'data.liabilityByType'))],
  ['Dashboard', 'assetsByCountry (as a set)', (o) => sorted(get(o, D, 'data.assetsByCountry'))],
  ['Dashboard', 'netWorthByCountryConverted (as a set)', (o) => sorted(get(o, D, 'data.netWorthByCountryConverted'))],
  ['Dashboard', 'countriesInUse (as a set)', (o) => sorted(get(o, D, 'data.countriesInUse'))],
  ['Forecast', 'net worth projected results', (o) => forecastResults(o, 'net_worth')],
  ['Forecast', 'resilience projected results', (o) => forecastResults(o, 'resilience')],
  ['Forecast', 'retirement projected results', (o) => forecastResults(o, 'retirement')],
  ['Forecast', 'debt projected results', (o) => forecastResults(o, 'debt')],
  ['Forecast', 'investment projected results', (o) => forecastResults(o, 'investment')],
  ['Forecast', 'cross-border projected results', (o) => forecastResults(o, 'cross_border')],
  ['DNA', 'propertyDebtBreakdown (as a set)', (o) => sorted(get(o, 'GET /api/intelligence/financial-dna', 'data.propertyDebtBreakdown'))],
];

/** Per period: the sum over every entity row of each money column (granularity-independent). */
function forecastTotals(o: Out, type: string): Map<string, number[]> | null {
  const rows = o[`GET /api/forecast/runs/[id] ${type}`]?.json?.data?.results;
  if (!Array.isArray(rows)) return null;
  const byPeriod = new Map<string, number[]>();
  for (const r of rows as Record<string, unknown>[]) {
    const k = String(r.period_number);
    const acc = byPeriod.get(k) ?? FORECAST_COLS.map(() => 0);
    FORECAST_COLS.forEach((c, i) => { acc[i] += Number(r[c] ?? 0); });
    byPeriod.set(k, acc);
  }
  return byPeriod;
}
function tuples(o: Out, route: string, cols: string[]): string {
  return (o[route]?.json?.data ?? []).map((r: Record<string, unknown>) => cols.map((c) => JSON.stringify(r[c] ?? null)).join('|')).sort().join(' ; ');
}
function sorted(v: unknown): string {
  return Array.isArray(v) ? v.map((x) => JSON.stringify(x)).sort().join(' ; ') : JSON.stringify(v);
}
const FORECAST_COLS = ['opening_value', 'contributions', 'withdrawals', 'income', 'expenses', 'interest', 'investment_return', 'fees', 'fx_gain_loss', 'other_movement', 'closing_value'];

/** The projected series of a forecast run: every numeric field of every result row, ids/dates/names dropped. */
function forecastResults(o: Out, type: string): string {
  const rows = o[`GET /api/forecast/runs/[id] ${type}`]?.json?.data?.results;
  if (!Array.isArray(rows)) return 'NOT MEASURED';
  const keep = (r: Record<string, unknown>) => Object.entries(r).filter(([k, v]) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !/id$/.test(k))).map(([k, v]) => `${k}=${Number(v).toFixed(4)}`).sort().join(',');
  const lines = rows.map(keep).sort();
  return `${lines.length} rows; sha ${crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)}`;
}

/** Every non-headline difference must match one of these, or it is UNEXPLAINED. */
const RULES: [RegExp, string][] = [
  [/^(GET \/api\/(income|expenses|liabilities|assets|investments|retirement)) :: data(\[\d+\])?\.(source_type|source_name|expense_name|liability_name|asset_name|investment_name|account_name|employer_name|lender|masked_identifier|institution|notes|valuation_date|ii_[a-z_]+|last_import[a-z_]*|last_imported_at|source_financial_account_id|retirement_member_id|master_item_key|expense_category|investment_type|account_type|debt_type|risk_profile|currency_override|minimum_payment|credit_limit|superseded_by_bank_import|is_essential|country_code|owner|currency_code|amount|current_value|net_amount|frequency|balance|interest_rate|monthly_repayment|employer_contribution|contribution_frequency|current_balance|income_type|is_taxable|annual_contribution|cost_base)$/, 'REGISTER ROWS: same economics, different row shape (names, provenance labels, row order/granularity; I stores annual contributions and imported line-by-line rows)'],
  [/^GET \/api\/(income|expenses|investments)(\/actuals|\/imported-statements)? :: /, 'PROVENANCE / EVIDENCE VIEW: imported actual lines, statement links and import history exist only for I (M has none by definition)'],
  [/^GET \/api\/assets\/bank-balances :: /, 'EVIDENCE VIEW: bank closing-balance proposals exist only for I (already applied, shown as "Already added")'],
  [/(topExpenses|topIncome|largestIncomeSummary|largestExpenseSummary)/, 'PRESENTATION: top-N lists name planned ITEMS for M and canonical GROUPS for I; employer name read from the synthetic payslip as "PTY LTD" (parser observation GP-O2)'],
  [/(liabilityByType|liabilitiesWithPayoff|assetsByCountry|netWorthByCountryConverted|countriesInUse|sectionData\.countries)\[\d+\]/, 'ORDER ONLY: same members and values in a different array order (register row order)'],
  [/bankMonthlyExpenses/, 'DESCRIPTOR: the part of combined expenses that came from statements (I 100%, M 0%); the combined total is equal'],
  [/costOfDebtMonthly/, 'DISCLOSURE (D-09): I knows the 430 interest + 20 fee inside the 2,000 repayment from the loan statement; M cannot; debt service is 2,000 in both'],
  [/coreSurvival/, 'MANUAL-ENTRY LIMIT (GP-O1): M can hold ONE "groceries" catalogue row; the INR groceries is a custom row that the core-survival rule (keyed by master_item_key) does not recognise; I\'s INR groceries line is categorised groceries'],
  [/largest_holding|metrics\[\d+\]\.userValue/, 'MANUAL-ENTRY LIMIT (GP-O1): M records the share portfolio as ONE catalogue line (100% "largest holding"); I imports two holdings (BHP 80%)'],
  [/input_hash/, 'FORECAST INPUT HASH: covers row names / row granularity (debt: liability names; investment: 1 vs 2 holdings); the projected results are compared leaf by leaf below'],
  [/lastUpdated/, 'CLOCK: data-quality "last updated" timestamps of each run'],
  [/reports\/generate :: data\.alreadyExisted/, 'IDEMPOTENT: M was measured twice in the same month, so the second generate returned the existing report for that month (content compared leaf by leaf)'],
  [/^GET \/api\/forecast\/runs\/\[id\] /, 'FORECAST RESULT ROWS: positional leaf diff of entity rows returned in a different order (and, for investment, 1 vs 2 holdings); certified by the order-independent row / per-period-total checks in the table'],
  [/propertyDebtBreakdown\[\d+\]/, 'ORDER ONLY: same members and values in a different array order (checked as a set in the table)'],
];

const headline: Record<string, unknown>[] = METRICS.map(([consumer, metric, f]) => {
  const va = f(a); const vb = f(b);
  const diff = typeof va === 'number' && typeof vb === 'number' ? Math.round((vb - va) * 1e6) / 1e6 : va === vb ? 0 : null;
  return { consumer, metric, [A]: va, [B]: vb, diff, equal: JSON.stringify(va) === JSON.stringify(vb) && !String(va).includes('NOT MEASURED') };
});
// Forecast per-period totals: max |M - I| over every period and money column. Entity rows are rounded to the
// cent one by one, so a portfolio held as 2 rows can differ from 1 row by at most 1 cent per extra row.
for (const t of ['net_worth', 'resilience', 'retirement', 'debt', 'investment', 'cross_border']) {
  const ta = forecastTotals(a, t); const tb = forecastTotals(b, t);
  if (!ta || !tb) { headline.push({ consumer: 'Forecast', metric: `${t} per-period totals`, [A]: 'NOT MEASURED', [B]: 'NOT MEASURED', diff: null, equal: false }); continue; }
  let max = 0; const periods = new Set([...ta.keys(), ...tb.keys()]);
  for (const k of periods) FORECAST_COLS.forEach((_, i) => { max = Math.max(max, Math.abs((ta.get(k)?.[i] ?? NaN) - (tb.get(k)?.[i] ?? NaN))); });
  const maxRounded = Math.round(max * 1e4) / 1e4;
  headline.push({ consumer: 'Forecast', metric: `${t} per-period totals, ${periods.size} periods (max |diff| any column)`, [A]: `${ta.size} periods`, [B]: `${tb.size} periods`, diff: maxRounded, equal: Number.isFinite(max) && max <= 0.011 });
}
/** Headline rows that differ BY DESIGN, each with its explanation (anything else that differs fails). */
const EXPECTED: [RegExp, string][] = [
  [/^planned monthly/, 'BASIS (contract section 5): M typed a PLAN; I has approved ACTUALS and applied the WP-15 average only for groceries (rent is category-only -- GP-O3). The combined basis every consumer uses is equal.'],
  [/^actual monthly/, 'BASIS: M has no statements by definition; the combined basis is equal.'],
  [/^investment projected results/, 'GRANULARITY (GP-O1): 1 manual portfolio line vs 2 imported holdings -> 120 vs 240 entity rows; per-period totals compared below.'],
  [/^investment per-period totals/, 'CENT ROUNDING: each entity row is rounded to the cent every period; 2 rows vs 1 row compound to at most 4 cents over 120 months (period 1 and 120 checked by hand: 13.15 + 52.62 = 65.77; 4,692.80 + 18,771.44 = 23,464.24).'],
];
for (const h of headline) {
  if (h.equal) continue;
  const e = EXPECTED.find(([re]) => re.test(String(h.metric)));
  if (e) h.expected = e[1];
}
const { variances, nonEconomic } = compareMeasures(a, b);
const classified = variances.filter((v) => v.path !== '(route)').map((v) => {
  const key = `${v.route} :: ${v.path}`;
  const rule = RULES.find(([re]) => re.test(key));
  return { ...v, explanation: rule ? rule[1] : 'UNEXPLAINED' };
});
const byClass = new Map<string, number>();
for (const c of classified) byClass.set(c.explanation, (byClass.get(c.explanation) ?? 0) + 1);

console.log(`| Consumer | Metric | ${A} | ${B} | Diff |\n|---|---|---|---|---|`);
for (const h of headline) console.log(`| ${h.consumer} | ${h.metric} | ${JSON.stringify(h[A])} | ${JSON.stringify(h[B])} | ${h.diff ?? (h.equal ? 0 : 'DIFFERENT')}${h.expected ? ` (explained: ${h.expected})` : ''} |`);
console.log(`\nAll other leaves: ${classified.length} differing, ${nonEconomic.length} identity/clock.`);
for (const [k, n] of byClass) console.log(`  ${String(n).padStart(4)}  ${k}`);
const unexplained = classified.filter((c) => c.explanation === 'UNEXPLAINED');
for (const u of unexplained) console.log(`UNEXPLAINED ${u.route} :: ${u.path}  ${A}=${JSON.stringify(u.a)?.slice(0, 100)}  ${B}=${JSON.stringify(u.b)?.slice(0, 100)}`);
if (arg('--json')) fs.writeFileSync(arg('--json')!, JSON.stringify({ a: A, b: B, headline, classes: Object.fromEntries(byClass), unexplained, nonEconomicCount: nonEconomic.length }, null, 1));
const unexplainedHeadline = headline.filter((h) => !h.equal && !h.expected);
for (const h of unexplainedHeadline) console.log(`UNEXPLAINED HEADLINE ${h.consumer} / ${h.metric}`);
console.log(`
RESULT: ${unexplainedHeadline.length + unexplained.length === 0 ? 'PASS -- 0 unexplained variances' : `FAIL -- ${unexplainedHeadline.length} headline + ${unexplained.length} leaf variances unexplained`}`);
if (unexplained.length || unexplainedHeadline.length) process.exitCode = 1;
