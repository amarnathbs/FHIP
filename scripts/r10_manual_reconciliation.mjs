// II-R10 terminal closure — 12 deep manual reconciliations (MR01-MR12).
// Seeds ONE disposable user with known, hand-computable values across
// every domain (cash flow, net worth, goals, retirement, II Performance/
// SIP/X-Ray/Tax), generates ONE real Premium report through the real
// app, then for each MR case independently re-derives the expected value
// (by direct arithmetic on the known seed inputs, or by re-querying a
// DIFFERENT canonical table/endpoint than the report builder itself
// reads) and compares it against the value actually persisted in that
// report's report_sections snapshot. Prints a clear per-case verdict
// table. Cleans up its own user at the end unless --keep is passed.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3219';
const KEEP = process.argv.includes('--keep');

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) { const m = line.match(/^([A-Za-z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(BASE).host.split('.')[0];

async function sb(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}
async function app(pathname, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(`${APP}${pathname}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json: json?.data ?? json };
}

const stamp = Date.now();
const MARKER = `MR${stamp}`;
const results = [];
function record(id, label, expected, actual, tolerance, note) {
  const ok = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(expected - actual) <= tolerance
    : expected === actual;
  results.push({ id, label, expected, actual, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${label}: expected=${expected} actual=${actual}${note ? ' -- ' + note : ''}`);
}

let userId, email, password;
try {
  email = `r10-mr-${stamp}@fhip-test.invalid`;
  password = `TestPass!${stamp}Aa1`;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  userId = created.json.id;
  await sb(`/rest/v1/user_entitlements?user_id=eq.${userId}`, { method: 'PATCH', body: { plan_tier: 'premium' } });
  await sb('/rest/v1/user_profiles', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { user_id: userId, full_name: MARKER, date_of_birth: '1985-06-15', country_of_residence: 'IN', preferred_currency: 'INR', onboarding_completed: true } });

  const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const session = await tokenRes.json();
  const cookie = `sb-${PROJECT_REF}-auth-token=base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64')}`;

  // ---- Seed known values ----
  // Cash flow: 2 income sources, 2 expense categories (known amounts)
  const INCOME_A = 120000, INCOME_B = 30000, EXP_ESSENTIAL = 45000, EXP_DISCRETIONARY = 8000;
  await sb('/rest/v1/income_sources', { method: 'POST', body: [
    { user_id: userId, source_name: 'Salary', income_type: 'salary', amount: INCOME_A, frequency: 'monthly', currency_code: 'INR', is_active: true },
    { user_id: userId, source_name: 'Freelance', income_type: 'salary', amount: INCOME_B, frequency: 'monthly', currency_code: 'INR', is_active: true },
  ] });
  await sb('/rest/v1/expense_items', { method: 'POST', body: [
    { user_id: userId, expense_name: 'Housing', amount: EXP_ESSENTIAL, frequency: 'monthly', is_essential: true, expense_category: 'housing', currency_code: 'INR', is_active: true },
    { user_id: userId, expense_name: 'Dining', amount: EXP_DISCRETIONARY, frequency: 'monthly', is_essential: false, expense_category: 'entertainment', currency_code: 'INR', is_active: true },
  ] });

  // Net worth: known assets + liabilities
  const ASSET_CASH = 300000, ASSET_PROPERTY = 5000000, LIABILITY_LOAN = 1200000;
  await sb('/rest/v1/assets', { method: 'POST', body: [
    { user_id: userId, asset_name: 'Savings', current_value: ASSET_CASH, asset_class: 'cash', country_code: 'IN', currency_code: 'INR', is_active: true },
    { user_id: userId, asset_name: 'Flat', current_value: ASSET_PROPERTY, asset_class: 'property', country_code: 'IN', currency_code: 'INR', is_active: true },
  ] });
  await sb('/rest/v1/liabilities', { method: 'POST', body: { user_id: userId, liability_name: 'Home Loan', balance: LIABILITY_LOAN, debt_type: 'home_loan', country_code: 'IN', currency_code: 'INR', is_active: true } });

  // Goals: known target/current -> known % progress
  const GOAL_TARGET = 500000, GOAL_CURRENT = 375000; // 75.0%
  await sb('/rest/v1/user_goals', { method: 'POST', body: { user_id: userId, goal_name: `${MARKER} Goal`, goal_type: 'savings', target_amount: GOAL_TARGET, current_amount: GOAL_CURRENT, currency_code: 'INR', target_date: '2027-06-30', status: 'active' } });

  // Retirement account: known balance
  const RETIREMENT_BALANCE = 2500000;
  await sb('/rest/v1/retirement_accounts', { method: 'POST', body: { user_id: userId, account_name: `${MARKER} NPS`, account_type: 'NPS', current_balance: RETIREMENT_BALANCE, currency_code: 'INR', country_code: 'IN', is_active: true } });

  // II Performance fund: known NAV series -> known return
  const [bench] = (await sb('/rest/v1/ii_benchmarks', { method: 'POST', prefer: 'return=representation', body: { benchmark_key: `${MARKER}_BM`, benchmark_label: `${MARKER} Benchmark`, benchmark_category: 'index', country_code: 'IN', return_type: 'TRI' } })).json;
  const [perfAcct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-PERF` } })).json;
  const [perfFund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} Growth Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } })).json;
  await sb('/rest/v1/ii_instrument_benchmarks', { method: 'POST', body: { instrument_id: perfFund.id, benchmark_id: bench.id, relationship_type: 'primary', effective_from: '1900-01-01', mapping_version: 'mr-v1', quality_status: 'ok' } });
  const navs = [], snaps = [], benchRows = [];
  const PERF_UNITS = 2000, PERF_START_NAV = 100, PERF_MONTHS = 12, PERF_MONTHLY_RETURN = 0.01; // 1%/mo compounding
  let nav = PERF_START_NAV, bLevel = 100;
  for (let i = 0; i < PERF_MONTHS; i++) {
    const date = new Date(Date.UTC(2024, i, 28)).toISOString().slice(0, 10);
    navs.push({ instrument_id: perfFund.id, currency_code: 'INR', price_date: date, price: nav.toFixed(6), quality_status: 'ok' });
    snaps.push({ user_id: userId, account_id: perfAcct.id, instrument_id: perfFund.id, currency_code: 'INR', as_of_date: date, units: PERF_UNITS.toFixed(6), value: (nav * PERF_UNITS).toFixed(2), quality_status: 'certified' });
    benchRows.push({ benchmark_id: bench.id, series_date: date, value: bLevel.toFixed(6), quality_status: 'ok' });
    nav *= 1 + PERF_MONTHLY_RETURN;
    bLevel *= 1.006;
  }
  await sb('/rest/v1/ii_prices_nav', { method: 'POST', body: navs });
  await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: snaps });
  await sb('/rest/v1/ii_benchmark_series', { method: 'POST', body: benchRows });
  await sb('/rest/v1/ii_transactions', { method: 'POST', body: { user_id: userId, account_id: perfAcct.id, instrument_id: perfFund.id, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2024-01-28', gross_amount: (PERF_START_NAV * PERF_UNITS).toFixed(2), units: PERF_UNITS.toFixed(6), status: 'reconciled' } });
  await sb('/rest/v1/ii_portfolio_truth_status', { method: 'POST', body: { user_id: userId, account_id: perfAcct.id, instrument_id: perfFund.id, status: 'certified', history_completeness: 'complete_from_inception' } });

  // II SIP: known 6 contributions of 5000 each -> known total invested
  const [sipAcct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-SIP` } })).json;
  const [sipFund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} SIP Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } })).json;
  const SIP_COUNT = 6, SIP_AMOUNT = 5000;
  const sipTxns = [], sipNavs = [], sipSnaps = [];
  let sipNav = 50, cumUnits = 0;
  for (let i = 0; i < SIP_COUNT; i++) {
    const date = new Date(Date.UTC(2024, 6 + i, 5)).toISOString().slice(0, 10);
    const units = SIP_AMOUNT / sipNav; cumUnits += units;
    sipTxns.push({ user_id: userId, account_id: sipAcct.id, instrument_id: sipFund.id, currency_code: 'INR', transaction_type: 'purchase', transaction_date: date, gross_amount: SIP_AMOUNT.toFixed(2), units: units.toFixed(6), price_per_unit: sipNav.toFixed(6), status: 'reconciled' });
    sipNavs.push({ instrument_id: sipFund.id, currency_code: 'INR', price_date: date, price: sipNav.toFixed(6), quality_status: 'ok' });
    sipSnaps.push({ user_id: userId, account_id: sipAcct.id, instrument_id: sipFund.id, currency_code: 'INR', as_of_date: date, units: cumUnits.toFixed(6), value: (cumUnits * sipNav).toFixed(2), quality_status: 'certified' });
    sipNav *= 1.01;
  }
  await sb('/rest/v1/ii_transactions', { method: 'POST', body: sipTxns });
  await sb('/rest/v1/ii_prices_nav', { method: 'POST', body: sipNavs });
  await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: sipSnaps });
  await sb('/rest/v1/ii_portfolio_truth_status', { method: 'POST', body: { user_id: userId, account_id: sipAcct.id, instrument_id: sipFund.id, status: 'certified', history_completeness: 'complete_from_inception' } });

  // II X-Ray: known single fund, known holding weights
  const [xrayAcct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-XRAY` } })).json;
  const [xrayFund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} Xray Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } })).json;
  const XRAY_VALUE = 800000;
  await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: { user_id: userId, account_id: xrayAcct.id, instrument_id: xrayFund.id, currency_code: 'INR', quality_status: 'certified', as_of_date: '2024-12-31', units: 1000, value: XRAY_VALUE } });
  const [xraySnap] = (await sb('/rest/v1/ii_fund_holdings_snapshots', { method: 'POST', prefer: 'return=representation', body: { fund_instrument_id: xrayFund.id, holdings_as_of_date: '2024-12-01', source_data_version: 'mr-v1', classification_version: 'amfi_sector_v1', source_document_version: 'mr-doc-1', quality_status: 'ok' } })).json;
  const XRAY_TOP_WEIGHT = 25.0;
  const [secInst] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} Top Holding`, instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } })).json;
  await sb('/rest/v1/ii_fund_holdings_lines', { method: 'POST', body: [
    { snapshot_id: xraySnap.id, underlying_instrument_id: secInst.id, holding_name: `${MARKER} Top Holding`, asset_kind: 'security', weight_pct: XRAY_TOP_WEIGHT, sector_code: 'Financial Services', market_cap_class: 'LARGE', resolution_method: 'ISIN' },
    { snapshot_id: xraySnap.id, holding_name: 'CASH', asset_kind: 'cash', weight_pct: 100 - XRAY_TOP_WEIGHT, resolution_method: 'UNRESOLVED' },
  ] });

  // II Tax: known purchase/redemption -> known short-term capital gain
  await sb('/rest/v1/ii_tax_profiles', { method: 'POST', body: { user_id: userId, taxpayer_type: 'RESIDENT_INDIVIDUAL', tax_residency_status: 'RESIDENT', tax_year: '2024-25' } });
  const [taxAcct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-TAX` } })).json;
  const [taxFund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} Tax Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } })).json;
  const TAX_BUY_AMOUNT = 100000, TAX_BUY_UNITS = 10000, TAX_SELL_AMOUNT = 150000; // known gain = 50000 (STCG, held < 12mo)
  await sb('/rest/v1/ii_transactions', { method: 'POST', body: [
    { user_id: userId, account_id: taxAcct.id, instrument_id: taxFund.id, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2024-03-01', gross_amount: TAX_BUY_AMOUNT.toFixed(2), units: TAX_BUY_UNITS.toFixed(6), price_per_unit: '10.00', status: 'reconciled' },
    { user_id: userId, account_id: taxAcct.id, instrument_id: taxFund.id, currency_code: 'INR', transaction_type: 'redemption', transaction_date: '2024-09-01', gross_amount: TAX_SELL_AMOUNT.toFixed(2), units: TAX_BUY_UNITS.toFixed(6), price_per_unit: '15.00', status: 'reconciled' },
  ] });
  await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: { user_id: userId, account_id: taxAcct.id, instrument_id: taxFund.id, currency_code: 'INR', as_of_date: '2024-09-01', units: 0, value: 0, quality_status: 'certified' } });

  // II Review items: known count/severities
  const REVIEW_ITEMS = [
    { title: `${MARKER} High severity item`, severity: 'high' },
    { title: `${MARKER} Medium severity item`, severity: 'medium' },
    { title: `${MARKER} Low severity item`, severity: 'low' },
  ];
  await sb('/rest/v1/ii_review_items', { method: 'POST', body: REVIEW_ITEMS.map((it, i) => ({
    user_id: userId, review_type: 'data_quality', category: 'test', severity: it.severity,
    compliance_classification: 'observation', title: it.title, description: 'MR test review item.',
    evidence: {}, source_module: 'ii_data_quality', review_engine_version: 'mr-test-v1', rule_key: `mr_test_${i}`,
    rule_version: 'v1', identity_key: `${MARKER}-${i}`, as_of_date: '2026-08-24', status: 'open',
  })) });

  await app('/api/forecast/run', { cookie, method: 'POST', body: { forecast_type: 'retirement', months: 240 } });
  await app('/api/investment-intelligence/review/refresh', { cookie, method: 'POST' });

  // ---- Generate the report ----
  const genRes = await app('/api/reports/generate', { cookie, method: 'POST', body: { reportType: 'net_worth' } });
  const reportId = genRes.json?.report?.id;
  const sections = genRes.json?.sections ?? [];
  console.log('report generated:', reportId, 'status:', genRes.status, 'sections:', sections.length);
  const byCode = Object.fromEntries(sections.map((s) => [s.sectionCode, s]));

  fs.writeFileSync('C:/Users/user/AppData/Local/Temp/claude/D--FHIP/754236a6-648e-4039-9457-c73bef97d4a2/scratchpad/pdf_pages/MR_report.json', JSON.stringify({ userId, email, password, reportId, sections }, null, 2));

  // ==== MR01: Gross income (cash_flow) ====
  const cf = byCode.cash_flow?.sectionData;
  record('MR01', 'Gross monthly income', INCOME_A + INCOME_B, cf?.grossIncome ?? cf?.metrics?.grossIncome ?? null, 0.01, 'cash_flow.sectionData');

  // ==== MR02: Essential expenses (cash_flow) ====
  record('MR02', 'Essential expenses', EXP_ESSENTIAL, cf?.essentialExpenses ?? null, 0.01);

  // ==== MR03: Monthly surplus (cash_flow) = (income) - (expenses) ====
  const expectedSurplus = (INCOME_A + INCOME_B) - (EXP_ESSENTIAL + EXP_DISCRETIONARY);
  record('MR03', 'Monthly surplus', expectedSurplus, cf?.surplus ?? null, 0.01);

  // ==== MR04: Net worth = assets - liabilities ====
  const nw = byCode.net_worth?.sectionData;
  const expectedNetWorth = (ASSET_CASH + ASSET_PROPERTY) - LIABILITY_LOAN;
  record('MR04', 'Net worth', expectedNetWorth, nw?.netWorth ?? null, 0.01, 'net_worth.sectionData');

  // ==== MR05: Total assets ====
  record('MR05', 'Total assets', ASSET_CASH + ASSET_PROPERTY, nw?.totalAssets ?? null, 0.01);

  // ==== MR06: Goal progress % ====
  const goals = byCode.goals?.sectionData;
  const expectedGoalPct = (GOAL_CURRENT / GOAL_TARGET) * 100;
  const actualGoal = goals?.goals?.[0] ?? goals?.items?.[0] ?? null;
  const actualGoalPct = actualGoal ? (actualGoal.progressPercent ?? actualGoal.percentComplete ?? null) : null;
  record('MR06', 'Goal progress %', Number(expectedGoalPct.toFixed(1)), actualGoalPct, 0.5, JSON.stringify(actualGoal)?.slice(0, 200));

  // ==== MR07: Retirement account balance ====
  const rr = byCode.retirement_readiness?.sectionData;
  record('MR07', 'Retirement balance', RETIREMENT_BALANCE, rr?.currentBalance ?? rr?.totalBalance ?? null, 1, JSON.stringify(rr)?.slice(0, 300));

  // ==== MR08: Investment performance total invested (Performance fund) ====
  const perf = byCode.investment_performance?.sectionData;
  const expectedInvested = PERF_START_NAV * PERF_UNITS;
  const perfHolding = perf?.holdings?.[0] ?? perf?.instruments?.[0] ?? null;
  record('MR08', 'Performance fund invested amount', expectedInvested, perfHolding?.investedAmount ?? perfHolding?.totalInvested ?? null, 1, JSON.stringify(perfHolding)?.slice(0, 300));

  // ==== MR09: SIP total invested = count * amount ====
  const sip = byCode.sip_contribution?.sectionData;
  const expectedSipTotal = SIP_COUNT * SIP_AMOUNT;
  const sipSeries = sip?.series?.[0] ?? sip?.contributions?.[0] ?? null;
  record('MR09', 'SIP total invested', expectedSipTotal, sipSeries?.totalInvested ?? sipSeries?.totalContributed ?? null, 1, JSON.stringify(sipSeries)?.slice(0, 300));

  // ==== MR10: Portfolio X-Ray top holding weight ====
  const xray = byCode.portfolio_xray?.sectionData;
  const topHolding = xray?.topHoldings?.[0] ?? xray?.holdings?.[0] ?? null;
  record('MR10', 'X-Ray top holding weight %', XRAY_TOP_WEIGHT, topHolding?.weightPct ?? topHolding?.weight ?? null, 0.5, JSON.stringify(topHolding)?.slice(0, 300));

  // ==== MR11: Tax capital gain = sell - buy ====
  const tax = byCode.tax_and_cost?.sectionData;
  const expectedGain = TAX_SELL_AMOUNT - TAX_BUY_AMOUNT;
  const taxLot = tax?.realizedGains?.[0] ?? tax?.lots?.[0] ?? tax?.transactions?.[0] ?? null;
  record('MR11', 'Realized capital gain', expectedGain, taxLot?.gainAmount ?? taxLot?.realizedGain ?? taxLot?.gain ?? null, 1, JSON.stringify(tax)?.slice(0, 400));

  // ==== MR12: Priority review items count + top severity ordering ====
  const review = byCode.priority_review_items?.sectionData;
  const items = review?.items ?? review?.openItems ?? [];
  const highCount = items.filter((i) => i.severity === 'high').length;
  record('MR12', 'Review items: at least 1 high-severity item present and ranked first', true, items[0]?.severity === 'high', 0, `items=${JSON.stringify(items.map((i) => i.severity))}`);

  console.log('\n=== SUMMARY ===');
  const passCount = results.filter((r) => r.ok).length;
  console.log(`${passCount}/${results.length} PASS`);
  fs.writeFileSync('C:/Users/user/AppData/Local/Temp/claude/D--FHIP/754236a6-648e-4039-9457-c73bef97d4a2/scratchpad/pdf_pages/MR_results.json', JSON.stringify(results, null, 2));
} finally {
  if (!KEEP && userId) {
    await sb(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
    console.log('cleaned up user', userId);
  } else if (KEEP) {
    console.log('KEEPING user:', `${userId}|${email}|${password}`);
  }
}
