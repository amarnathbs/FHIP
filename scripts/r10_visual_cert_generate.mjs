// II-R10 terminal closure — visual certification report generator.
// Usage: node scripts/r10_visual_cert_generate.mjs <APP_URL> <SCENARIO>
// Seeds real DEV data for one of 15 named scenarios, generates a real
// report + PDF via the real app, downloads the PDF locally, and prints a
// JSON summary (report id, section list + key values) for the manual
// reconciliation record. Cleans up its own user at the end UNLESS
// --keep is passed (used for historical-immutability / revise tests that
// need the user to persist across two script invocations).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3219';
const SCENARIO = process.argv[3];
const KEEP = process.argv.includes('--keep');
const REUSE_USER = (process.argv.find((a) => a.startsWith('--user=')) ?? '').replace('--user=', '') || null;
const OUT_DIR = 'C:/Users/user/AppData/Local/Temp/claude/D--FHIP/754236a6-648e-4039-9457-c73bef97d4a2/scratchpad/pdf_pages';
fs.mkdirSync(OUT_DIR, { recursive: true });

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
const MARKER = `VC${SCENARIO}${stamp}`;

async function makeOrReuseUser(tier) {
  if (REUSE_USER) {
    const [userId, email, password] = REUSE_USER.split('|');
    const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const session = await tokenRes.json();
    const cookie = `sb-${PROJECT_REF}-auth-token=base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64')}`;
    return { userId, email, password, cookie };
  }
  const email = `r10-vc-${SCENARIO.toLowerCase()}-${stamp}@fhip-test.invalid`;
  const password = `TestPass!${stamp}Aa1`;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const userId = created.json.id;
  await sb(`/rest/v1/user_entitlements?user_id=eq.${userId}`, { method: 'PATCH', body: { plan_tier: tier } });
  const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const session = await tokenRes.json();
  const cookie = `sb-${PROJECT_REF}-auth-token=base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64')}`;
  return { userId, email, password, cookie };
}

async function seedBasics(userId, { income = 150000, expense = 60000, currency = 'INR', country = 'IN' } = {}) {
  await sb('/rest/v1/user_profiles', { method: 'POST', prefer: 'resolution=merge-duplicates', body: { user_id: userId, full_name: MARKER, date_of_birth: '1985-06-15', country_of_residence: country, preferred_currency: currency, onboarding_completed: true } });
  // income_sources.income_type and .currency_code are both NOT NULL --
  // found this session (visual certification round) that every earlier
  // script's income/expense seed was silently failing on this exact
  // constraint (a 400 error never checked), meaning the cash_flow and
  // stress_testing chapters were correctly showing "unavailable" for a
  // genuinely different reason than expected: no income/expense data ever
  // actually existed. This also fully explains the previously-unresolved
  // "why was essentialMonthlyExpenses 0" question in
  // R10_RETIREMENT_ROOT_CAUSE.md -- the expense seed was silently failing
  // there too. Fixed here; net-worth-only checks elsewhere this session
  // (assets/liabilities/investments/retirement, which always DID set
  // currency_code) are unaffected by this.
  const incRes = await sb('/rest/v1/income_sources', { method: 'POST', body: { user_id: userId, source_name: 'Salary', income_type: 'salary', amount: income, frequency: 'monthly', currency_code: currency, is_active: true } });
  if (!incRes.ok) throw new Error(`income seed failed: ${incRes.text}`);
  const expRes = await sb('/rest/v1/expense_items', { method: 'POST', body: { user_id: userId, expense_name: 'Household', amount: expense, frequency: 'monthly', is_essential: true, expense_category: 'housing', currency_code: currency, is_active: true } });
  if (!expRes.ok) throw new Error(`expense seed failed: ${expRes.text}`);
}

async function seedPerformanceFund(userId, { months = 15, monthlyReturn = 0.012, currency = 'INR', country = 'IN', nameSuffix = '' } = {}) {
  const [bench] = (await sb('/rest/v1/ii_benchmarks', { method: 'POST', prefer: 'return=representation', body: { benchmark_key: `${MARKER}_BM${nameSuffix}`, benchmark_label: `${MARKER} Benchmark${nameSuffix}`, benchmark_category: 'index', country_code: country, return_type: 'TRI' } })).json;
  const rows = []; let level = 100;
  for (let i = 0; i < months; i++) { rows.push({ benchmark_id: bench.id, series_date: new Date(Date.UTC(2024, i, 28)).toISOString().slice(0, 10), value: level.toFixed(6), quality_status: 'ok' }); level *= 1.006; }
  await sb('/rest/v1/ii_benchmark_series', { method: 'POST', body: rows });
  const [acct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: country, currency_code: currency, account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-PERF${nameSuffix}` } })).json;
  const [fund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} Growth Fund${nameSuffix}`, instrument_class: 'mutual_fund', country_of_domicile: country, base_currency: currency, status: 'verified' } })).json;
  await sb('/rest/v1/ii_instrument_benchmarks', { method: 'POST', body: { instrument_id: fund.id, benchmark_id: bench.id, relationship_type: 'primary', effective_from: '1900-01-01', mapping_version: 'vc-v1', quality_status: 'ok' } });
  const navs = []; const snaps = []; let nav = 100;
  for (let i = 0; i < months; i++) {
    const date = new Date(Date.UTC(2024, i, 28)).toISOString().slice(0, 10);
    navs.push({ instrument_id: fund.id, currency_code: currency, price_date: date, price: nav.toFixed(6), quality_status: 'ok' });
    snaps.push({ user_id: userId, account_id: acct.id, instrument_id: fund.id, currency_code: currency, as_of_date: date, units: '2000.000000', value: (nav * 2000).toFixed(2), quality_status: 'certified' });
    nav *= 1 + monthlyReturn;
  }
  await sb('/rest/v1/ii_prices_nav', { method: 'POST', body: navs });
  await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: snaps });
  await sb('/rest/v1/ii_transactions', { method: 'POST', body: { user_id: userId, account_id: acct.id, instrument_id: fund.id, currency_code: currency, transaction_type: 'purchase', transaction_date: '2024-01-28', gross_amount: '200000.00', units: '2000.000000', status: 'reconciled' } });
  await sb('/rest/v1/ii_portfolio_truth_status', { method: 'POST', body: { user_id: userId, account_id: acct.id, instrument_id: fund.id, status: 'certified', history_completeness: 'complete_from_inception' } });
  return { acct, fund };
}

async function seedSip(userId, { seriesCount = 6, currency = 'INR', country = 'IN' } = {}) {
  const [acct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: country, currency_code: currency, account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-SIP` } })).json;
  const [fund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} SIP Fund`, instrument_class: 'mutual_fund', country_of_domicile: country, base_currency: currency, status: 'verified' } })).json;
  const txns = []; const navs = []; const snaps = [];
  let nav = 50; let cumUnits = 0;
  for (let i = 0; i < seriesCount; i++) {
    const date = new Date(Date.UTC(2024, 6 + i, 5)).toISOString().slice(0, 10);
    const units = 5000 / nav; cumUnits += units;
    txns.push({ user_id: userId, account_id: acct.id, instrument_id: fund.id, currency_code: currency, transaction_type: 'purchase', transaction_date: date, gross_amount: '5000.00', units: units.toFixed(6), price_per_unit: nav.toFixed(6), status: 'reconciled' });
    navs.push({ instrument_id: fund.id, currency_code: currency, price_date: date, price: nav.toFixed(6), quality_status: 'ok' });
    snaps.push({ user_id: userId, account_id: acct.id, instrument_id: fund.id, currency_code: currency, as_of_date: date, units: cumUnits.toFixed(6), value: (cumUnits * nav).toFixed(2), quality_status: 'certified' });
    nav *= 1.015;
  }
  await sb('/rest/v1/ii_transactions', { method: 'POST', body: txns });
  await sb('/rest/v1/ii_prices_nav', { method: 'POST', body: navs });
  await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: snaps });
  await sb('/rest/v1/ii_portfolio_truth_status', { method: 'POST', body: { user_id: userId, account_id: acct.id, instrument_id: fund.id, status: 'certified', history_completeness: 'complete_from_inception' } });
}

async function seedXray(userId, { fundCount = 3, currency = 'INR', country = 'IN' } = {}) {
  const funds = [
    { name: 'Bluechip Equity Fund', value: 1000000, holdings: [
      { sec: 'Reliance Industries', weightPct: 9.5, sectorCode: 'Financial Services', marketCapClass: 'LARGE' },
      { sec: 'HDFC Bank', weightPct: 8.2, sectorCode: 'Financial Services', marketCapClass: 'LARGE' },
      { sec: 'Infosys', weightPct: 7.1, sectorCode: 'Information Technology', marketCapClass: 'LARGE' },
      { sec: 'TCS', weightPct: 6.4, sectorCode: 'Information Technology', marketCapClass: 'LARGE' },
    ] },
    { name: 'Flexi Cap Fund', value: 600000, holdings: [
      { sec: 'Reliance Industries', weightPct: 8.0, sectorCode: 'Financial Services', marketCapClass: 'LARGE' },
      { sec: 'HDFC Bank', weightPct: 7.5, sectorCode: 'Financial Services', marketCapClass: 'LARGE' },
      { sec: 'Persistent Systems', weightPct: 5.5, sectorCode: 'Information Technology', marketCapClass: 'MID' },
    ] },
    { name: 'Corporate Bond Fund', value: 400000, holdings: [
      { sec: 'GOI 7.26% 2033', weightPct: 32.0, creditRatingBand: 'SOVEREIGN', maturityDate: '2033-08-22', modifiedDuration: 6.4 },
      { sec: 'HDFC Ltd NCD 2027', weightPct: 22.0, creditRatingBand: 'AAA', maturityDate: '2027-03-15', modifiedDuration: 2.3 },
    ] },
  ].slice(0, fundCount);
  for (const f of funds) {
    const [acct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: country, currency_code: currency, account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-${f.name.replace(/\s/g, '')}` } })).json;
    const [fund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} ${f.name}`, instrument_class: 'mutual_fund', country_of_domicile: country, base_currency: currency, status: 'verified' } })).json;
    await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: { user_id: userId, account_id: acct.id, instrument_id: fund.id, currency_code: currency, quality_status: 'certified', as_of_date: '2024-12-31', units: 1000, value: f.value } });
    const [snap] = (await sb('/rest/v1/ii_fund_holdings_snapshots', { method: 'POST', prefer: 'return=representation', body: { fund_instrument_id: fund.id, holdings_as_of_date: '2024-12-01', source_data_version: 'vc-v1', classification_version: 'amfi_sector_v1', source_document_version: 'vc-doc-1', quality_status: 'ok' } })).json;
    const lines = [];
    for (const h of f.holdings) {
      let secId = null;
      if (h.sec) {
        const [s] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `${MARKER} ${h.sec}`, instrument_class: 'equity', country_of_domicile: country, base_currency: currency, status: 'verified' } })).json;
        secId = s.id;
      }
      lines.push({ snapshot_id: snap.id, underlying_instrument_id: secId, holding_name: h.sec ? `${MARKER} ${h.sec}` : 'CASH', asset_kind: h.sec ? 'security' : 'cash', weight_pct: h.weightPct, sector_code: h.sectorCode ?? null, market_cap_class: h.marketCapClass ?? null, credit_rating_band: h.creditRatingBand ?? null, maturity_date: h.maturityDate ?? null, modified_duration: h.modifiedDuration ?? null, resolution_method: h.sec ? 'ISIN' : 'UNRESOLVED' });
    }
    lines.push({ snapshot_id: snap.id, holding_name: 'CASH', asset_kind: 'cash', weight_pct: 100 - f.holdings.reduce((s, h) => s + h.weightPct, 0), resolution_method: 'UNRESOLVED' });
    await sb('/rest/v1/ii_fund_holdings_lines', { method: 'POST', body: lines });
  }
}

async function seedTax(userId, { currency = 'INR', country = 'IN', longName = false } = {}) {
  await sb('/rest/v1/ii_tax_profiles', { method: 'POST', body: { user_id: userId, taxpayer_type: 'RESIDENT_INDIVIDUAL', tax_residency_status: 'RESIDENT', tax_year: '2024-25' } });
  const [acct] = (await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, country_code: country, currency_code: currency, account_type: 'mf_folio', institution_name: `${MARKER} AMC`, folio_number: `${MARKER}-TAX` } })).json;
  const name = longName ? `${MARKER} A Fund With A Deliberately Very Long Name For Table Width Stress Testing Purposes` : `${MARKER} Tax Test Fund`;
  const [fund] = (await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: name, instrument_class: 'mutual_fund', country_of_domicile: country, base_currency: currency, status: 'verified' } })).json;
  await sb('/rest/v1/ii_transactions', { method: 'POST', body: [
    { user_id: userId, account_id: acct.id, instrument_id: fund.id, currency_code: currency, transaction_type: 'purchase', transaction_date: '2024-03-01', gross_amount: '100000.00', units: '10000.000000', price_per_unit: '10.00', status: 'reconciled' },
    { user_id: userId, account_id: acct.id, instrument_id: fund.id, currency_code: currency, transaction_type: 'redemption', transaction_date: '2024-09-01', gross_amount: '180000.00', units: '10000.000000', price_per_unit: '18.00', status: 'reconciled' },
  ] });
  await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: { user_id: userId, account_id: acct.id, instrument_id: fund.id, currency_code: currency, as_of_date: '2024-09-01', units: 0, value: 0, quality_status: 'certified' } });
}

async function seedGoals(userId, { longName = false, count = 2 } = {}) {
  const names = longName
    ? [`${MARKER} A Deliberately Long Goal Name To Stress-Test Report Table And Chart Label Layout Handling`, `${MARKER} Another Goal`]
    : [`${MARKER} Emergency Fund`, `${MARKER} House Deposit`];
  const goals = [];
  if (count >= 1) goals.push((await sb('/rest/v1/user_goals', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, goal_name: names[0], goal_type: 'savings', target_amount: 500000, current_amount: 480000, currency_code: 'INR', target_date: '2026-12-31', status: 'active' } })).json[0]);
  if (count >= 2) goals.push((await sb('/rest/v1/user_goals', { method: 'POST', prefer: 'return=representation', body: { user_id: userId, goal_name: names[1], goal_type: 'savings', target_amount: 5000000, current_amount: 10000, currency_code: 'INR', target_date: '2026-12-31', status: 'active' } })).json[0]);
  return goals;
}

async function seedReviewItems(userId, items) {
  const rows = items.map((it, i) => ({
    user_id: userId, review_type: it.type ?? 'data_quality', category: it.category ?? 'test', severity: it.severity ?? 'medium',
    compliance_classification: 'observation', title: it.title, description: it.description ?? 'Test review item description.',
    evidence: {}, source_module: it.sourceModule ?? 'ii_data_quality', review_engine_version: 'vc-test-v1', rule_key: `vc_test_${i}`,
    rule_version: 'v1', identity_key: `${MARKER}-${i}`, as_of_date: '2026-08-24', status: 'open',
  }));
  await sb('/rest/v1/ii_review_items', { method: 'POST', body: rows });
}

let userId, email, password;
try {
  // VC01 (Free/simple household) is about the FREE REPORT'S CONTENT
  // quality, not entitlement gating (already separately and repeatedly
  // live-verified: a real Free user's PDF export attempt is DENIED 403 --
  // see R10_SECURITY_VERIFICATION.md). PDF export itself is a Premium-only
  // feature by design, so a genuinely free-tier user has no downloadable
  // PDF to visually inspect at all -- using 'premium' here for VC01 only
  // means the free-equivalent Free-report sections (identical composition
  // either way) are followed by the Premium-only chapters, which are
  // simply not populated for this minimal seed and render as their own
  // correctly-labelled "not applicable"/"unavailable" states -- still a
  // faithful visual proxy for what a Free-tier user's own report content
  // looks like, page for page, up to the point Premium content begins.
  const tier = 'premium';
  const user = await makeOrReuseUser(tier);
  userId = user.userId; email = user.email; password = user.password;
  const cookie = user.cookie;

  switch (SCENARIO) {
    case 'VC01': // Free/simple household
      await seedBasics(userId);
      await sb('/rest/v1/assets', { method: 'POST', body: { user_id: userId, asset_name: 'Savings', current_value: 200000, asset_class: 'cash', country_code: 'IN', currency_code: 'INR', is_active: true } });
      await sb('/rest/v1/liabilities', { method: 'POST', body: { user_id: userId, liability_name: 'Car Loan', balance: 50000, debt_type: 'auto_loan', country_code: 'IN', currency_code: 'INR', is_active: true } });
      break;
    case 'VC02': // Premium/simple household
      await seedBasics(userId);
      await sb('/rest/v1/assets', { method: 'POST', body: { user_id: userId, asset_name: 'Savings', current_value: 200000, asset_class: 'cash', country_code: 'IN', currency_code: 'INR', is_active: true } });
      break;
    case 'VC03': // Investment-heavy
      await seedBasics(userId);
      await seedPerformanceFund(userId);
      await seedSip(userId);
      await seedXray(userId, { fundCount: 2 });
      await seedTax(userId);
      await seedReviewItems(userId, [{ title: 'Unallocated investment detected', severity: 'medium', category: 'portfolio' }]);
      break;
    case 'VC04': // Performance/benchmark-heavy
      await seedBasics(userId);
      await seedPerformanceFund(userId, { months: 15 });
      break;
    case 'VC05': // SIP-heavy
      await seedBasics(userId);
      await seedSip(userId, { seriesCount: 8 });
      break;
    case 'VC06': // X-Ray-heavy
      await seedBasics(userId);
      await seedXray(userId, { fundCount: 3 });
      break;
    case 'VC07': // Tax-heavy
      await seedBasics(userId);
      await seedTax(userId);
      break;
    case 'VC08': // Multiple goals (ON_TRACK + OFF_TRACK)
      await seedBasics(userId);
      await seedGoals(userId, { count: 2 });
      break;
    case 'VC09': // Retirement-heavy
      await seedBasics(userId);
      await sb('/rest/v1/retirement_accounts', { method: 'POST', body: { user_id: userId, account_name: `${MARKER} NPS`, account_type: 'NPS', current_balance: 800000, currency_code: 'INR', country_code: 'IN', is_active: true } });
      break;
    case 'VC10': // Review-Centre-heavy
      await seedBasics(userId);
      await seedReviewItems(userId, [
        { title: 'Tax classification data incomplete', severity: 'high', category: 'tax', sourceModule: 'ii_r6_tax' },
        { title: 'SIP contribution interrupted', severity: 'medium', category: 'sip', sourceModule: 'ii_r5_sip_xray' },
        { title: 'Portfolio concentration in a single sector', severity: 'low', category: 'portfolio', sourceModule: 'ii_r5_sip_xray' },
        { title: 'Unallocated investment detected', severity: 'medium', category: 'goals', sourceModule: 'goals' },
      ]);
      break;
    case 'VC11': // Partial/incomplete data
      await sb('/rest/v1/income_sources', { method: 'POST', body: { user_id: userId, source_name: 'Salary', income_type: 'salary', amount: 50000, frequency: 'monthly', currency_code: 'INR', is_active: true } });
      break;
    case 'VC12': // No Investments
      await seedBasics(userId);
      await seedGoals(userId, { count: 1 });
      break;
    case 'VC13': // No Goals
      await seedBasics(userId);
      await seedPerformanceFund(userId, { months: 13 });
      break;
    case 'VC14': // Cross-currency
      await seedBasics(userId, { currency: 'AUD', country: 'AU' });
      await sb('/rest/v1/assets', { method: 'POST', body: { user_id: userId, asset_name: 'AU Savings', current_value: 50000, asset_class: 'cash', country_code: 'AU', currency_code: 'AUD', is_active: true } });
      await seedPerformanceFund(userId, { currency: 'INR', country: 'IN', nameSuffix: '_INR' });
      break;
    case 'VC15': // Stress: long names, many holdings/goals/review items, negative values
      await seedBasics(userId);
      await seedGoals(userId, { longName: true, count: 2 });
      await seedTax(userId, { longName: true });
      await sb('/rest/v1/retirement_accounts', { method: 'POST', body: { user_id: userId, account_name: `${MARKER} A Retirement Account With A Genuinely Long Name For Layout Stress Testing And Overflow Checking`, account_type: 'NPS', current_balance: 12345678, currency_code: 'INR', country_code: 'IN', is_active: true } });
      await sb('/rest/v1/liabilities', { method: 'POST', body: { user_id: userId, liability_name: 'A Deliberately Long Liability Name For Stress Testing Table Column Widths And Wrapping Behaviour', balance: 999999, debt_type: 'personal_loan', country_code: 'IN', currency_code: 'INR', is_active: true } });
      await seedReviewItems(userId, Array.from({ length: 8 }, (_, i) => ({ title: `Stress test review item number ${i + 1} with a moderately long descriptive title for layout`, severity: ['low', 'medium', 'high'][i % 3], category: 'stress' })));
      break;
  }

  // Retirement forecast trigger for scenarios that include a retirement account
  if (['VC09', 'VC15'].includes(SCENARIO)) {
    await app('/api/forecast/run', { cookie, method: 'POST', body: { forecast_type: 'retirement', months: 240 } });
  }
  if (['VC03', 'VC10'].includes(SCENARIO)) {
    await app('/api/investment-intelligence/review/refresh', { cookie, method: 'POST' });
  }

  const genRes = await app('/api/reports/generate', { cookie, method: 'POST', body: { reportType: 'net_worth' } });
  const reportId = genRes.json?.report?.id;
  const sections = genRes.json?.sections ?? [];
  console.log(`${SCENARIO} report:`, reportId, 'sections:', sections.length, 'status:', genRes.status);
  console.log('section summary:', JSON.stringify(sections.map((s) => ({ code: s.sectionCode, status: s.sectionStatus }))));

  let pdfPath = null;
  if (reportId) {
    const exportRes = await app(`/api/reports/${reportId}/exports`, { cookie, method: 'POST', body: { format: 'pdf' } });
    if (exportRes.json?.storage_path) {
      const fileRes = await fetch(`${BASE}/storage/v1/object/report-exports/${exportRes.json.storage_path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
      const buf = Buffer.from(await fileRes.arrayBuffer());
      pdfPath = `${OUT_DIR}/${SCENARIO}.pdf`;
      fs.writeFileSync(pdfPath, buf);
      console.log('PDF saved:', pdfPath, buf.length, 'bytes');
    } else {
      console.log('PDF export did not produce a storage_path:', JSON.stringify(exportRes.json).slice(0, 300));
    }
  }

  fs.writeFileSync(`${OUT_DIR}/${SCENARIO}.json`, JSON.stringify({ scenario: SCENARIO, userId, email, password, reportId, sections, pdfPath }, null, 2));
  console.log('SUMMARY_JSON_PATH:', `${OUT_DIR}/${SCENARIO}.json`);
} finally {
  if (!KEEP && userId) {
    await sb(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
    console.log('cleaned up user', userId);
  } else if (KEEP) {
    console.log('KEEPING user for follow-up:', `${userId}|${email}|${password}`);
  }
}
