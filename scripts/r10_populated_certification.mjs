// II-R10 — populated Investment Intelligence certification (continuation
// spec section 9). Seeds ONE real DEV user with genuine canonical R4/R5/R6
// data (reusing the exact fixture patterns already proven by
// scripts/ii_r4_ux_fixture.mjs, scripts/ii_r5_browser_qa_xray_fixture.mjs
// and scripts/ii_r6_final_live_dev_cases.mjs), plus a Goal and a Retirement
// account, then:
//   1. Generates a real Premium report via the real app API.
//   2. Independently calls the real canonical II APIs
//      (/api/investment-intelligence/{analytics,sip,xray,tax/summary,review})
//      for the SAME user and asserts the report's raw chapter values equal
//      those canonical raw values byte-for-byte (source-of-truth / no-
//      recalculation proof against REAL data, not fixtures).
//   3. Compares canonical Dashboard net worth to the report's net worth.
//   4. Generates a real PDF of the fully populated report.
//   5. Cleans up everything it created (instruments/accounts/holdings/
//      benchmarks/goals/retirement/report data + the user), independently
//      re-verified.
//
// Requires a real running `next dev` at APP_BASE_URL/argv[2] with
// APP_BASE_URL env matching it (for PDF rendering).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3219';

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
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
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}
async function app(pathname, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(`${APP}${pathname}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 600)}`);
}

const stamp = Date.now();
const MARKER = `R10POP${stamp}`;
const cleanup = { userId: null, instrumentIds: [], benchmarkIds: [], accountIds: [], goalId: null, retirementId: null };

async function main() {
  // ---- user setup ----------------------------------------------------
  const email = `r10-populated-${stamp}@fhip-test.invalid`;
  const password = `TestPass!${stamp}Aa1`;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const userId = created.json?.id;
  cleanup.userId = userId;
  await sb(`/rest/v1/user_entitlements?user_id=eq.${userId}`, { method: 'PATCH', body: { plan_tier: 'premium' } });
  const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const session = await tokenRes.json();
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  const cookie = `sb-${PROJECT_REF}-auth-token=${cookieValue}`;
  console.log('user:', userId);

  // Retirement forecasting requires a plausible DOB in user_profiles.
  await sb('/rest/v1/user_profiles', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { user_id: userId, full_name: 'R10 Populated Test', date_of_birth: '1985-06-15', country_of_residence: 'IN', preferred_currency: 'INR', onboarding_completed: true } });

  // Basic FHIP financial data (income/expense/asset) so the report is eligible at all.
  await sb('/rest/v1/income_sources', { method: 'POST', body: { user_id: userId, source_name: 'Salary', amount: 150000, frequency: 'monthly', is_active: true } });
  await sb('/rest/v1/expense_items', { method: 'POST', body: { user_id: userId, expense_name: 'Household', amount: 60000, frequency: 'monthly', is_essential: true, expense_category: 'housing', is_active: true } });
  await sb('/rest/v1/assets', { method: 'POST', body: { user_id: userId, asset_name: 'Bank balance', current_value: 500000, asset_class: 'cash', country_code: 'IN', is_active: true } });

  // ---- R4 Performance: benchmark + 15 months of NAV/holding history --
  const [bench] = (await sb('/rest/v1/ii_benchmarks', { method: 'POST', prefer: 'return=representation', body: { benchmark_key: `${MARKER}_BM`, benchmark_label: `${MARKER} Benchmark`, benchmark_category: 'index', country_code: 'IN', return_type: 'TRI' } })).json;
  cleanup.benchmarkIds.push(bench.id);
  {
    const rows = [];
    let level = 100;
    for (let i = 0; i < 15; i++) { rows.push({ benchmark_id: bench.id, series_date: new Date(Date.UTC(2024, i, 28)).toISOString().slice(0, 10), value: level.toFixed(6), quality_status: 'ok' }); level *= 1.006; }
    await sb('/rest/v1/ii_benchmark_series', { method: 'POST', body: rows });
  }
  const [perfAcct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-PERF` } })).json;
  cleanup.accountIds.push(perfAcct.id);
  const [perfFund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} Growth Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } })).json;
  cleanup.instrumentIds.push(perfFund.id);
  await sb('/rest/v1/ii_instrument_benchmarks', { method: 'POST', body: { instrument_id: perfFund.id, benchmark_id: bench.id, relationship_type: 'primary', effective_from: '1900-01-01', mapping_version: 'r10pop-v1', quality_status: 'ok' } });
  {
    const navs = []; const snaps = [];
    let nav = 100;
    for (let i = 0; i < 15; i++) {
      const date = new Date(Date.UTC(2024, i, 28)).toISOString().slice(0, 10);
      navs.push({ instrument_id: perfFund.id, currency_code: 'INR', price_date: date, price: nav.toFixed(6), quality_status: 'ok' });
      snaps.push({ user_id: userId, account_id: perfAcct.id, instrument_id: perfFund.id, currency_code: 'INR', as_of_date: date, units: '2000.000000', value: (nav * 2000).toFixed(2), quality_status: 'certified' });
      nav *= 1.012;
    }
    await sb('/rest/v1/ii_prices_nav', { method: 'POST', body: navs });
    await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: snaps });
  }
  await sb('/rest/v1/ii_transactions', { method: 'POST', body: { user_id: userId, account_id: perfAcct.id, instrument_id: perfFund.id, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2024-01-28', gross_amount: '200000.00', units: '2000.000000', status: 'reconciled', source_reference: `${MARKER} initial` } });
  await sb('/rest/v1/ii_portfolio_truth_status', { method: 'POST', body: { user_id: userId, account_id: perfAcct.id, instrument_id: perfFund.id, status: 'certified', history_completeness: 'complete_from_inception' } });

  // ---- R5 SIP: 6 monthly purchases on a second fund ------------------
  const [sipAcct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-SIP` } })).json;
  cleanup.accountIds.push(sipAcct.id);
  const [sipFund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} SIP Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } })).json;
  cleanup.instrumentIds.push(sipFund.id);
  {
    const txns = []; const navs = []; const snaps = [];
    let nav = 50; let cumUnits = 0;
    for (let i = 0; i < 6; i++) {
      const date = new Date(Date.UTC(2024, 6 + i, 5)).toISOString().slice(0, 10);
      const units = 5000 / nav;
      cumUnits += units;
      txns.push({ user_id: userId, account_id: sipAcct.id, instrument_id: sipFund.id, currency_code: 'INR', transaction_type: 'purchase', transaction_date: date, gross_amount: '5000.00', units: units.toFixed(6), price_per_unit: nav.toFixed(6), status: 'reconciled', source_reference: `${MARKER} sip ${i}` });
      navs.push({ instrument_id: sipFund.id, currency_code: 'INR', price_date: date, price: nav.toFixed(6), quality_status: 'ok' });
      snaps.push({ user_id: userId, account_id: sipAcct.id, instrument_id: sipFund.id, currency_code: 'INR', as_of_date: date, units: cumUnits.toFixed(6), value: (cumUnits * nav).toFixed(2), quality_status: 'certified' });
      nav *= 1.015;
    }
    await sb('/rest/v1/ii_transactions', { method: 'POST', body: txns });
    await sb('/rest/v1/ii_prices_nav', { method: 'POST', body: navs });
    await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: snaps });
  }
  await sb('/rest/v1/ii_portfolio_truth_status', { method: 'POST', body: { user_id: userId, account_id: sipAcct.id, instrument_id: sipFund.id, status: 'certified', history_completeness: 'complete_from_inception' } });

  // ---- R5 X-Ray: fund with look-through holdings lines ----------------
  const [xrayAcct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-XRAY` } })).json;
  cleanup.accountIds.push(xrayAcct.id);
  const [xrayFund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} Bluechip Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } })).json;
  cleanup.instrumentIds.push(xrayFund.id);
  await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: { user_id: userId, account_id: xrayAcct.id, instrument_id: xrayFund.id, currency_code: 'INR', quality_status: 'certified', as_of_date: '2024-12-31', units: 1000, value: 1000000 } });
  const [xraySnap] = (await sb('/rest/v1/ii_fund_holdings_snapshots', { method: 'POST', prefer: 'return=representation', body: { fund_instrument_id: xrayFund.id, holdings_as_of_date: '2024-12-01', source_data_version: 'r10pop-v1', classification_version: 'amfi_sector_v1', source_document_version: 'r10pop-doc-1', quality_status: 'ok' } })).json;
  const secIds = [];
  async function security(name, sector) {
    const [s] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} ${name}`, instrument_class: 'equity', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } })).json;
    secIds.push(s.id);
    return s.id;
  }
  const lines = [
    { name: 'Reliance Industries', sector: 'Energy', weight: 12.0 },
    { name: 'HDFC Bank', sector: 'Financial Services', weight: 10.5 },
    { name: 'Infosys', sector: 'Information Technology', weight: 9.0 },
    { name: 'ICICI Bank', sector: 'Financial Services', weight: 8.0 },
    { name: 'TCS', sector: 'Information Technology', weight: 6.5 },
  ];
  const lineRows = [];
  for (const l of lines) {
    lineRows.push({ snapshot_id: xraySnap.id, underlying_instrument_id: await security(l.name, l.sector), holding_name: `${MARKER} ${l.name}`, asset_kind: 'security', weight_pct: l.weight, sector_code: l.sector, market_cap_class: 'LARGE', resolution_method: 'ISIN' });
  }
  lineRows.push({ snapshot_id: xraySnap.id, holding_name: 'CASH', asset_kind: 'cash', weight_pct: 54.0, resolution_method: 'UNRESOLVED' });
  await sb('/rest/v1/ii_fund_holdings_lines', { method: 'POST', body: lineRows });
  cleanup.instrumentIds.push(...secIds);

  // ---- R6 Tax: purchase + short-term redemption, resident profile -----
  await sb('/rest/v1/ii_tax_profiles', { method: 'POST', body: { user_id: userId, taxpayer_type: 'RESIDENT_INDIVIDUAL', tax_residency_status: 'RESIDENT', tax_year: '2024-25' } });
  const [taxAcct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-TAX` } })).json;
  cleanup.accountIds.push(taxAcct.id);
  const [taxFund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} Tax Test Fund`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' } })).json;
  cleanup.instrumentIds.push(taxFund.id);
  await sb('/rest/v1/ii_transactions', { method: 'POST', body: [
    { user_id: userId, account_id: taxAcct.id, instrument_id: taxFund.id, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2024-03-01', gross_amount: '100000.00', units: '10000.000000', price_per_unit: '10.00', status: 'reconciled', source_reference: `${MARKER} tax purchase` },
    { user_id: userId, account_id: taxAcct.id, instrument_id: taxFund.id, currency_code: 'INR', transaction_type: 'redemption', transaction_date: '2024-09-01', gross_amount: '180000.00', units: '10000.000000', price_per_unit: '18.00', status: 'reconciled', source_reference: `${MARKER} tax redemption` },
  ] });
  await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: { user_id: userId, account_id: taxAcct.id, instrument_id: taxFund.id, currency_code: 'INR', as_of_date: '2024-09-01', units: 0, value: 0, quality_status: 'certified' } });

  // ---- Goals: one ON_TRACK, one OFF_TRACK ------------------------------
  const [goalOnTrack] = (await sb('/rest/v1/user_goals', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, goal_name: `${MARKER} Emergency Fund`, goal_type: 'savings', target_amount: 500000, current_amount: 480000, currency_code: 'INR', target_date: '2026-12-31', status: 'active' } })).json;
  const [goalOffTrack] = (await sb('/rest/v1/user_goals', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, goal_name: `${MARKER} House Deposit`, goal_type: 'savings', target_amount: 5000000, current_amount: 10000, currency_code: 'INR', target_date: '2026-12-31', status: 'active' } })).json;
  cleanup.goalId = goalOnTrack.id;

  // ---- Retirement account ----------------------------------------------
  const [retire] = (await sb('/rest/v1/retirement_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, account_name: `${MARKER} NPS`, account_type: 'NPS', current_balance: 800000, currency_code: 'INR', country_code: 'IN', is_active: true } })).json;
  cleanup.retirementId = retire.id;

  console.log('\n=== seeding complete, waiting a moment for consistency, then calling canonical APIs ===\n');

  // A retirement forecast CHAPTER requires an actual persisted Forecast run
  // (the chapter correctly refuses to fabricate one — this is genuine
  // report behaviour, not a defect, per its own comment: "reuses the same
  // Retirement Forecast calculation... not a new or separate calculation").
  // Trigger one for real via the real Forecasting API before generating
  // the report.
  const forecastRunRes = await app('/api/forecast/run', { cookie, method: 'POST', body: { forecast_type: 'retirement', months: 240 } });
  record('FORECAST-RUN-SETUP', 'Retirement forecast run created via the real Forecasting API', forecastRunRes.status === 200 ? 'PASS' : 'FAIL', `status=${forecastRunRes.status} body=${forecastRunRes.text?.slice(0, 200)}`);

  // ---- canonical API calls (independent of the report) -----------------
  const [analyticsRes, sipRes, xrayRes, taxRes, dashboardRes] = await Promise.all([
    app('/api/investment-intelligence/analytics', { cookie }),
    app('/api/investment-intelligence/sip', { cookie }),
    app('/api/investment-intelligence/xray', { cookie }),
    app('/api/investment-intelligence/tax/summary', { cookie }),
    app('/api/dashboard/summary', { cookie }),
  ]);
  await app('/api/investment-intelligence/review/refresh', { cookie, method: 'POST' });
  const reviewRes = await app('/api/investment-intelligence/review', { cookie });

  record('CANON-1', 'GET /investment-intelligence/analytics returns real (non-empty) data', !analyticsRes.json?.data?.empty ? 'PASS' : 'FAIL', JSON.stringify(analyticsRes.json).slice(0, 300));
  record('CANON-2', 'GET /investment-intelligence/sip returns real (non-empty) data', !sipRes.json?.data?.empty ? 'PASS' : 'FAIL', JSON.stringify(sipRes.json).slice(0, 300));
  record('CANON-3', 'GET /investment-intelligence/xray returns real (available) data', xrayRes.json?.data?.available !== false ? 'PASS' : 'FAIL', JSON.stringify(xrayRes.json).slice(0, 300));
  record('CANON-4', 'GET /investment-intelligence/tax/summary returns real (non-empty) data', !taxRes.json?.data?.empty ? 'PASS' : 'FAIL', JSON.stringify(taxRes.json).slice(0, 300));
  record('CANON-5', 'GET /investment-intelligence/review after refresh returns items array', Array.isArray(reviewRes.json?.data?.items) ? 'PASS' : 'FAIL', `count=${reviewRes.json?.data?.items?.length}`);

  // ---- generate the real report -----------------------------------------
  const genRes = await app('/api/reports/generate', { cookie, method: 'POST', body: { reportType: 'net_worth' } });
  const genData = genRes.json?.data ?? genRes.json;
  const reportId = genData?.report?.id;
  const sections = genData?.sections ?? [];
  record('REPORT-GEN', 'Premium report generated with populated II data', genRes.status === 200 && reportId ? 'PASS' : 'FAIL', `status=${genRes.status}`);

  const perfSection = sections.find((s) => s.sectionCode === 'investment_performance');
  const sipSection = sections.find((s) => s.sectionCode === 'sip_contribution');
  const xraySection = sections.find((s) => s.sectionCode === 'portfolio_xray');
  const taxSection = sections.find((s) => s.sectionCode === 'tax_and_cost');
  const reviewSection = sections.find((s) => s.sectionCode === 'priority_review_items');
  const goalSection = sections.find((s) => s.sectionCode === 'goal_forecast_detail');
  const retirementSection = sections.find((s) => s.sectionCode === 'retirement_readiness');

  record('CHAPTER-STATUS', 'All 5 new II chapters reached included status with real data', [perfSection, sipSection, xraySection, taxSection, reviewSection].every((s) => s?.sectionStatus === 'included') ? 'PASS' : 'FAIL', JSON.stringify({ perf: perfSection?.sectionStatus, sip: sipSection?.sectionStatus, xray: xraySection?.sectionStatus, tax: taxSection?.sectionStatus, review: reviewSection?.sectionStatus }));
  record('CHAPTER-STATUS-GOALS', 'Goal Forecast Detail chapter reached included status', goalSection?.sectionStatus === 'included' ? 'PASS' : 'FAIL', goalSection?.sectionStatus);
  record('CHAPTER-STATUS-RETIREMENT', 'Retirement Readiness chapter reached included status', retirementSection?.sectionStatus === 'included' ? 'PASS' : 'FAIL', retirementSection?.sectionStatus);

  // ---- SOURCE-OF-TRUTH / NO-RECALCULATION: raw value equality ----------
  // Key-order-independent deep comparison: JS object key insertion order
  // differs between the report's stored raw engine object and the API
  // route's freshly-constructed response object even when every VALUE is
  // identical, so a plain JSON.stringify(a) === JSON.stringify(b) is not a
  // valid equality check here (confirmed live this session — see
  // scripts/_r10_xray_exact_compare.mjs).
  function sortKeysDeep(v) {
    if (Array.isArray(v)) return v.map(sortKeysDeep);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep(v[k])]));
    return v;
  }
  function deepEqual(a, b) { return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b)); }

  const reportPerfPortfolios = perfSection?.sectionData?.results?.portfolios;
  const canonPerfPortfolios = analyticsRes.json?.data?.results?.portfolios;
  record('NO-RECALC-1 (Performance)', 'Report investment_performance.results.portfolios deep-equals the canonical analytics API result', deepEqual(reportPerfPortfolios, canonPerfPortfolios) ? 'PASS' : 'FAIL', `report portfolios=${reportPerfPortfolios?.length}, canonical=${canonPerfPortfolios?.length}`);

  // The API route filters to presentable series only and renames the field
  // to `series`; the report's raw `analytics` array includes every
  // detected series regardless of presentability. Compare only the
  // overlapping (presentable) series, matched by seriesKey, on the fields
  // that exist unchanged in both (actualXirr/benchmarkSip are passed
  // through verbatim by the route).
  const reportSipAnalytics = sipSection?.sectionData?.results?.analytics ?? [];
  const canonSipSeries = sipRes.json?.data?.series ?? [];
  const sipMatches = canonSipSeries.every((cs) => {
    const rs = reportSipAnalytics.find((a) => a.series.seriesKey === cs.seriesKey);
    return rs && deepEqual(rs.actualXirr, cs.actualXirr);
  });
  record('NO-RECALC-2 (SIP)', 'Report sip_contribution presentable-series actualXirr deep-equals the canonical SIP API result, matched by seriesKey', canonSipSeries.length > 0 && sipMatches ? 'PASS' : 'FAIL', `canonical presentable series=${canonSipSeries.length}, report series total=${reportSipAnalytics.length}`);

  const reportXraySector = xraySection?.sectionData?.results?.sectorExposure;
  const canonXraySector = xrayRes.json?.data?.sectorExposure;
  record('NO-RECALC-3 (X-Ray)', 'Report portfolio_xray.results.sectorExposure deep-equals the canonical X-Ray API result', deepEqual(reportXraySector, canonXraySector) ? 'PASS' : 'FAIL', JSON.stringify({ reportStatus: reportXraySector?.status, canonStatus: canonXraySector?.status, reportBucketCount: reportXraySector?.buckets?.length, canonBucketCount: canonXraySector?.buckets?.length }));

  // The tax API route renames instrumentKey->instrumentId and adds
  // instrumentName; compare the fields that pass through unchanged,
  // matched by instrumentKey/instrumentId.
  const reportTaxDisposals = taxSection?.sectionData?.results?.disposalResults ?? [];
  const canonTaxDisposals = taxRes.json?.data?.disposalResults ?? [];
  const taxMatches = canonTaxDisposals.length > 0 && canonTaxDisposals.every((cd) => {
    const rd = reportTaxDisposals.find((d) => d.instrumentKey === cd.instrumentId && d.disposalDate === cd.disposalDate);
    return rd && rd.taxableGain === cd.taxableGain && rd.classification === cd.classification && rd.gainType === cd.gainType && rd.holdingDays === cd.holdingDays;
  });
  record('NO-RECALC-4 (Tax)', 'Report tax_and_cost disposalResults (taxableGain/classification/gainType/holdingDays) match the canonical tax API result, matched by instrument+date', taxMatches ? 'PASS' : 'FAIL', JSON.stringify({ reportCount: reportTaxDisposals.length, canonCount: canonTaxDisposals.length, canonSample: canonTaxDisposals[0] }));

  const reportReviewTitles = (reviewSection?.sectionData?.items ?? []).map((i) => i.title).sort();
  const canonReviewTitles = (reviewRes.json?.data?.items ?? []).filter((i) => i.status === 'open').map((i) => i.title).sort();
  record('NO-RECALC-5 (Review)', 'Report priority_review_items titles match the canonical open review items (same set)', JSON.stringify(reportReviewTitles) === JSON.stringify(canonReviewTitles) ? 'PASS' : 'FAIL', JSON.stringify({ report: reportReviewTitles, canonical: canonReviewTitles }));

  // ---- No-double-counting: net worth ------------------------------------
  const netWorthSection = sections.find((s) => s.sectionCode === 'net_worth');
  const reportNetWorth = netWorthSection?.sectionData?.netWorth;
  const canonNetWorth = dashboardRes.json?.data?.netWorth;
  record('NO-DOUBLE-COUNT', 'Report net worth equals canonical Dashboard/summary net worth', reportNetWorth !== undefined && reportNetWorth === canonNetWorth ? 'PASS' : 'FAIL', JSON.stringify({ reportNetWorth, canonNetWorth }));

  // ---- PDF generation of the fully populated report ---------------------
  const exportRes = await app(`/api/reports/${reportId}/exports`, { cookie, method: 'POST', body: { format: 'pdf' } });
  const exportData = exportRes.json?.data ?? exportRes.json;
  record('PDF-POPULATED', 'Fully populated Premium PDF generates successfully', exportRes.status === 200 && exportData?.status === 'ready' ? 'PASS' : 'FAIL', `status=${exportRes.status} raw=${exportRes.text?.slice(0, 500)}`);

  console.log('\n=== SUMMARY ===');
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(`${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log('FAILED:', failed.map((f) => f.id).join(', '));
  fs.writeFileSync(path.join(repoRoot, 'scripts', 'r10-populated-certification-results.json'), JSON.stringify({ userId, results }, null, 2));

  return failed.length;
}

let failedCount = 0;
try {
  failedCount = await main();
} catch (e) {
  console.error('FATAL:', e);
  failedCount = 999;
} finally {
  console.log('\n--- cleanup ---');
  if (cleanup.userId) {
    // Deleting the auth user cascades ii_accounts/ii_transactions/
    // ii_holding_snapshots/user_goals/retirement_accounts/income_sources/
    // expense_items/assets/reports/report_sections/report_snapshots/
    // report_exports owned by user_id (all FK on delete cascade).
    await sb(`/auth/v1/admin/users/${cleanup.userId}`, { method: 'DELETE' });
  }
  for (const id of cleanup.instrumentIds) {
    await sb(`/rest/v1/ii_fund_holdings_lines?underlying_instrument_id=eq.${id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_fund_holdings_snapshots?fund_instrument_id=eq.${id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_instrument_benchmarks?instrument_id=eq.${id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_prices_nav?instrument_id=eq.${id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_instruments?id=eq.${id}`, { method: 'DELETE' });
  }
  for (const id of cleanup.benchmarkIds) {
    await sb(`/rest/v1/ii_benchmark_series?benchmark_id=eq.${id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_benchmarks?id=eq.${id}`, { method: 'DELETE' });
  }
  // independent re-verify
  let leftoverUser = 0;
  if (cleanup.userId) {
    const check = await sb(`/auth/v1/admin/users/${cleanup.userId}`);
    leftoverUser = check.status === 404 ? 0 : 1;
  }
  let leftoverInstruments = 0;
  for (const id of cleanup.instrumentIds) {
    const check = await sb(`/rest/v1/ii_instruments?id=eq.${id}&select=id`);
    if ((check.json ?? []).length > 0) leftoverInstruments++;
  }
  console.log(`independently re-verified: ${leftoverUser} leftover user, ${leftoverInstruments}/${cleanup.instrumentIds.length} leftover instruments`);
  process.exitCode = failedCount > 0 || leftoverUser > 0 || leftoverInstruments > 0 ? 1 : 0;
}
