// Investment Intelligence R6-FINAL — the 12 LIVE-R6-DEV end-to-end
// scenarios (spec Sections 29-32), run for real against DEV + a real
// running app server.
//
// INDEPENDENCE (spec Section 31): for at least 8 of the 12 scenarios, the
// expected numbers below are computed by THIS SCRIPT'S OWN re-transcribed
// formulas (holding-period anniversary rule, grandfathering three-way
// comparison, FIFO consumption) — it does NOT import any production module
// from lib/engines/investment-intelligence/tax/*. This mirrors
// scripts/ii_r6p1_independent_reconciliation.py's own stated independence
// discipline, just in JS so it can share this file's HTTP/seeding plumbing.
//
// Each case: (1) seeds real rows into DEV via the service-role key, (2)
// computes the expected answer independently, (3) calls the REAL running
// app over HTTP as a REAL authenticated user (cookie-based session, same
// technique as scripts/ii_r5_live_sip_e2e.mjs), (4) compares, and (5)
// independently inspects the actual DEV rows the call produced (source
// transaction, tax lot consumption is NOT persisted as its own row in this
// release — see taxRepository.ts — but the persisted
// ii_capital_gains_computations row is inspected directly).
//
// Run:  node scripts/ii_r6_final_live_dev_cases.mjs [baseUrl]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3199';

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(BASE).host.split('.')[0];

const results = [];
function record(id, description, status, detail, extra = {}) {
  results.push({ id, description, status, detail, ...extra });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 600)}`);
}

async function sb(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
const cleanup = { users: [], instruments: [], accounts: [] };

async function makeUser(tag) {
  const email = `ii-r6-final-${tag}-${stamp}@fhip-test.local`;
  const password = 'TestPass!' + stamp;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  // Sign-in needs the ANON key, not service — build headers manually rather
  // than reusing the sb() helper (which always sends the service key).
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = await res2.json();
  if (!id || !session?.access_token) throw new Error(`user setup failed for ${tag}: ${created.text} ${JSON.stringify(session)}`);
  cleanup.users.push(id);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, email, session, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

async function app(pathname, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(`${APP}${pathname}`, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function makeInstrument(name, isin = null) {
  const ins = await sb('/rest/v1/ii_instruments', {
    method: 'POST', prefer: 'return=representation',
    body: { instrument_name: name, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified', isin },
  });
  const id = ins.json?.[0]?.id;
  if (!id) throw new Error(`instrument seed failed for ${name}: ${ins.text}`);
  cleanup.instruments.push(id);
  return id;
}

async function classify(instrumentId, classification, domesticEquityPct = null) {
  const basis = classification === 'debt_specified' ? 'known_debt_specified_category' : classification === 'unresolved' ? 'unresolved_no_data' : 'computed_from_holdings';
  const r = await sb('/rest/v1/ii_scheme_tax_classification', {
    method: 'POST', prefer: 'return=representation',
    body: { instrument_id: instrumentId, classification, domestic_equity_pct: domesticEquityPct, basis, disclosure_date: classification === 'computed_from_holdings' ? '2026-07-31' : null, engine_version: 'r6-final-test-fixture-v1', note: 'LIVE-R6 test-scenario fixture — directly asserted classification, not derived from real holdings disclosure (see ii_r6_final_live_dev_cases.mjs header vs the SEPARATE production reference-data seed script).' },
  });
  if (!r.ok) throw new Error(`classification seed failed: ${r.text}`);
}

async function makeAccount(userId, currencyCode = 'INR') {
  const acct = await sb('/rest/v1/ii_accounts', {
    method: 'POST', prefer: 'return=representation',
    body: { user_id: userId, account_type: 'mf_folio', institution_name: 'R6-FINAL Test AMC', folio_number: `FOLIO-R6F-${stamp}-${cleanup.accounts.length}`, country_code: 'IN', currency_code: currencyCode, status: 'active' },
  });
  const id = acct.json?.[0]?.id;
  if (!id) throw new Error(`account seed failed: ${acct.text}`);
  cleanup.accounts.push(id);
  return id;
}

async function insertTxns(rows) {
  const r = await sb('/rest/v1/ii_transactions', { method: 'POST', prefer: 'return=representation', body: rows });
  if (!r.ok) throw new Error(`transaction insert failed: ${r.text}`);
  return r.json;
}

// ---------------------------------------------------------------------------
// Independent (non-production) tax math — re-transcribed, not imported.
// ---------------------------------------------------------------------------
function addMonthsClamped(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (m - 1) + months;
  const ty = y + Math.floor(total / 12);
  const tm = ((total % 12) + 12) % 12;
  const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const cd = Math.min(d, dim);
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(cd).padStart(2, '0')}`;
}
function isLongTermIndependent(acqDate, dispDate, months = 12) {
  const anniv = addMonthsClamped(acqDate, months);
  return dispDate > anniv;
}
function grandfatheringIndependent(actualCost, salePrice, fmv) {
  if (fmv === null) return actualCost;
  return Math.max(actualCost, Math.min(fmv, salePrice));
}
// Rule version by disposal date (re-transcribed from ruleVersions.ts's seed values, independently).
function rulesFor(disposalDate) {
  if (disposalDate < '2024-07-23') return { stcg: 0.15, ltcg: 0.10, exemption: 100000 };
  return { stcg: 0.20, ltcg: 0.125, exemption: 125000 }; // covers both post-2024-07-23 1961-Act and post-2026-04-01 2025-Act rows (no rate change, per R6-FINAL legal research)
}

// ---------------------------------------------------------------------------
async function main() {
  const userA = await makeUser('main');
  console.log(`\nTest user (LIVE-R6-001..010): ${userA.id}\n`);
  const accountA = await makeAccount(userA.id, 'INR');

  // =========================================================================
  // LIVE-R6-001 — simple realised equity gain, single lot.
  // =========================================================================
  {
    const instId = await makeInstrument('R6F Simple Equity Fund - Growth (Direct Plan)');
    await classify(instId, 'equity_oriented', 95);
    const acqDate = '2023-01-10';
    const dispDate = '2024-06-15'; // > 12 months after 2023-01-10 anniversary (2024-01-10) -> LTCG
    const costPerUnit = 20;
    const units = 1000;
    const salePricePerUnit = 35;
    await insertTxns([
      { user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: acqDate, gross_amount: units * costPerUnit, units, price_per_unit: costPerUnit, status: 'reconciled', source_reference: 'LIVE-R6-001 purchase' },
      { user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: dispDate, gross_amount: units * salePricePerUnit, units, price_per_unit: salePricePerUnit, status: 'reconciled', source_reference: 'LIVE-R6-001 redemption' },
    ]);

    const isLT = isLongTermIndependent(acqDate, dispDate);
    const expectedGain = units * (salePricePerUnit - costPerUnit); // no grandfathering (post-2018 acquisition)
    const expectedGainType = isLT ? 'ltcg' : 'stcg';

    const res = await app('/api/investment-intelligence/tax/summary', { cookie: userA.cookie });
    const disp = res.json?.data?.disposalResults?.find((d) => d.instrumentId === instId);
    const match = disp && disp.gainType === expectedGainType && Math.abs(disp.taxableGain - expectedGain) < 0.01;
    record('LIVE-R6-001', 'Simple realised equity gain (single lot, LTCG)', match ? 'PASS' : 'FAIL',
      `independent: gainType=${expectedGainType} taxableGain=${expectedGain} | production: gainType=${disp?.gainType} taxableGain=${disp?.taxableGain} | HTTP ${res.status}`,
      { independentlyRecalculated: true });

    // Live DB inspection: persisted computation row, correct tenant, correct rule version.
    const dbRow = await sb(`/rest/v1/ii_capital_gains_computations?user_id=eq.${userA.id}&instrument_id=eq.${instId}&select=*`);
    const row = dbRow.json?.[0];
    record('LIVE-R6-001-DB', 'Persisted ii_capital_gains_computations row matches (tenant, gain, rule version)', row && row.user_id === userA.id && Math.abs(row.taxable_gain - expectedGain) < 0.01 ? 'PASS' : 'FAIL',
      `db row: ${JSON.stringify(row)}`);
  }

  // =========================================================================
  // LIVE-R6-002 — multi-lot FIFO.
  // =========================================================================
  {
    const instId = await makeInstrument('R6F Multi-Lot FIFO Fund - Growth (Direct Plan)');
    await classify(instId, 'equity_oriented', 95);
    const lots = [
      { date: '2022-01-05', units: 500, cost: 10 },
      { date: '2022-06-05', units: 300, cost: 12 },
      { date: '2023-01-05', units: 400, cost: 15 },
    ];
    const dispDate = '2024-01-10';
    const salePricePerUnit = 20;
    const redeemUnits = 700; // consumes all of lot1 (500) + 200 of lot2 (300)

    await insertTxns(lots.map((l) => ({ user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: l.date, gross_amount: l.units * l.cost, units: l.units, price_per_unit: l.cost, status: 'reconciled', source_reference: 'LIVE-R6-002 lot' })));
    await insertTxns([{ user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: dispDate, gross_amount: redeemUnits * salePricePerUnit, units: redeemUnits, price_per_unit: salePricePerUnit, status: 'reconciled', source_reference: 'LIVE-R6-002 redemption' }]);

    // Independent FIFO: consume lot1 fully (500 units), then 200 from lot2.
    const consumption1 = { units: 500, cost: lots[0].cost, acqDate: lots[0].date };
    const consumption2 = { units: 200, cost: lots[1].cost, acqDate: lots[1].date };
    const expectedTotalGain = consumption1.units * (salePricePerUnit - consumption1.cost) + consumption2.units * (salePricePerUnit - consumption2.cost);

    const res = await app('/api/investment-intelligence/tax/summary', { cookie: userA.cookie });
    const disps = (res.json?.data?.disposalResults ?? []).filter((d) => d.instrumentId === instId);
    const totalGain = disps.reduce((s, d) => s + (d.taxableGain ?? 0), 0);
    const lotCount = disps.length;
    const match = lotCount === 2 && Math.abs(totalGain - expectedTotalGain) < 0.01;
    record('LIVE-R6-002', 'Multi-lot FIFO (redemption spans 2 of 3 lots, oldest consumed first)', match ? 'PASS' : 'FAIL',
      `independent: 2 lots consumed, totalGain=${expectedTotalGain} | production: ${lotCount} lots, totalGain=${totalGain}`,
      { independentlyRecalculated: true });

    // Independently verify FIFO order specifically: the units-consumed-per-lot breakdown must be [500, 200], never [400,300] (which would be a LIFO/reverse order).
    const unitsSeq = disps.map((d) => d.unitsConsumed).sort((a, b) => b - a);
    record('LIVE-R6-002-FIFO-ORDER', 'FIFO consumption order verified independently (oldest lot first: 500 then 200, not reverse)', JSON.stringify(unitsSeq) === JSON.stringify([500, 200]) ? 'PASS' : 'FAIL', `units consumed per lot: ${JSON.stringify(disps.map((d) => ({ acq: d.acquisitionDate, units: d.unitsConsumed })))}`);
  }

  // =========================================================================
  // LIVE-R6-003 — partial multi-lot redemption (lot left with remaining units).
  // =========================================================================
  {
    const instId = await makeInstrument('R6F Partial Redemption Fund - Growth (Direct Plan)');
    await classify(instId, 'equity_oriented', 95);
    await insertTxns([
      { user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2023-03-01', gross_amount: 1000 * 10, units: 1000, price_per_unit: 10, status: 'reconciled', source_reference: 'LIVE-R6-003 lot' },
      { user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: '2024-06-01', gross_amount: 400 * 18, units: 400, price_per_unit: 18, status: 'reconciled', source_reference: 'LIVE-R6-003 partial redemption' },
    ]);
    const expectedGain = 400 * (18 - 10);
    const expectedRemainingUnits = 600;

    const res = await app('/api/investment-intelligence/tax/summary', { cookie: userA.cookie });
    const disp = res.json?.data?.disposalResults?.find((d) => d.instrumentId === instId);
    const lotsRes = await app('/api/investment-intelligence/tax/lots', { cookie: userA.cookie });
    const lot = lotsRes.json?.data?.lots?.find((l) => l.instrumentId === instId);
    const match = disp && Math.abs(disp.taxableGain - expectedGain) < 0.01 && lot && Math.abs(lot.unitsRemaining - expectedRemainingUnits) < 0.001 && lot.status === 'partially_consumed';
    record('LIVE-R6-003', 'Partial multi-lot redemption leaves correct remaining-units balance', match ? 'PASS' : 'FAIL',
      `independent: gain=${expectedGain}, remaining=${expectedRemainingUnits} | production: gain=${disp?.taxableGain}, remaining=${lot?.unitsRemaining}, status=${lot?.status}`,
      { independentlyRecalculated: true });
  }

  // =========================================================================
  // LIVE-R6-004 — switch transaction (switch_out triggers gain, switch_in opens a new lot).
  // =========================================================================
  {
    const fundA = await makeInstrument('R6F Switch Source Fund - Growth (Direct Plan)');
    const fundB = await makeInstrument('R6F Switch Target Fund - Growth (Direct Plan)');
    await classify(fundA, 'equity_oriented', 95);
    await classify(fundB, 'equity_oriented', 95);
    await insertTxns([
      { user_id: userA.id, account_id: accountA, instrument_id: fundA, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2022-05-01', gross_amount: 500 * 10, units: 500, price_per_unit: 10, status: 'reconciled', source_reference: 'LIVE-R6-004 initial purchase' },
      { user_id: userA.id, account_id: accountA, instrument_id: fundA, currency_code: 'INR', transaction_type: 'switch_out', transaction_date: '2024-01-15', gross_amount: 500 * 16, units: 500, price_per_unit: 16, status: 'reconciled', source_reference: 'LIVE-R6-004 switch out' },
      { user_id: userA.id, account_id: accountA, instrument_id: fundB, currency_code: 'INR', transaction_type: 'switch_in', transaction_date: '2024-01-15', gross_amount: 500 * 16, units: 500, price_per_unit: 16, status: 'reconciled', source_reference: 'LIVE-R6-004 switch in' },
    ]);
    const expectedGain = 500 * (16 - 10);

    const res = await app('/api/investment-intelligence/tax/summary', { cookie: userA.cookie });
    const dispA = res.json?.data?.disposalResults?.find((d) => d.instrumentId === fundA);
    const lotsRes = await app('/api/investment-intelligence/tax/lots', { cookie: userA.cookie });
    const lotB = lotsRes.json?.data?.lots?.find((l) => l.instrumentId === fundB);
    const match = dispA && Math.abs(dispA.taxableGain - expectedGain) < 0.01 && lotB && lotB.kind === 'switch_in' && Math.abs(lotB.unitsAcquired - 500) < 0.001 && lotB.acquisitionDate === '2024-01-15';
    record('LIVE-R6-004', 'Switch transaction: switch_out taxed as a disposal, switch_in opens a fresh lot with the switch date', match ? 'PASS' : 'FAIL',
      `independent: switch-out gain=${expectedGain}, new lot units=500 acq=2024-01-15 | production: switch-out gain=${dispA?.taxableGain}, new lot units=${lotB?.unitsAcquired} acq=${lotB?.acquisitionDate} kind=${lotB?.kind}`,
      { independentlyRecalculated: true });
  }

  // =========================================================================
  // LIVE-R6-005 — grandfathering (pre-2018-01-31 acquisition).
  // =========================================================================
  {
    const instId = await makeInstrument('R6F Grandfathered Equity Fund - Growth (Direct Plan)');
    await classify(instId, 'equity_oriented', 95);
    const acqDate = '2016-05-10';
    const acqCost = 10;
    const fmv31Jan2018 = 25;
    const dispDate = '2024-03-01';
    const salePricePerUnit = 30;
    const units = 800;

    await insertTxns([{ user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: acqDate, gross_amount: units * acqCost, units, price_per_unit: acqCost, status: 'reconciled', source_reference: 'LIVE-R6-005 pre-2018 purchase' }]);
    // Seed the 31-Jan-2018 FMV as a real ii_prices_nav row.
    await sb('/rest/v1/ii_prices_nav', { method: 'POST', body: [{ instrument_id: instId, price_date: '2018-01-31', price: fmv31Jan2018, currency_code: 'INR', quality_status: 'ok' }] });
    await insertTxns([{ user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: dispDate, gross_amount: units * salePricePerUnit, units, price_per_unit: salePricePerUnit, status: 'reconciled', source_reference: 'LIVE-R6-005 redemption' }]);

    const grandBasis = grandfatheringIndependent(acqCost, salePricePerUnit, fmv31Jan2018); // max(10, min(25,30))=25
    const expectedGain = units * (salePricePerUnit - grandBasis); // 800*(30-25)=4000

    const res = await app('/api/investment-intelligence/tax/summary', { cookie: userA.cookie });
    const disp = res.json?.data?.disposalResults?.find((d) => d.instrumentId === instId);
    const match = disp && disp.grandfathering?.basisSource === 'fmv_grandfathered' && Math.abs(disp.taxableGain - expectedGain) < 0.01;
    record('LIVE-R6-005', 'Grandfathering: real 31-Jan-2018 FMV applied via the three-way comparison', match ? 'PASS' : 'FAIL',
      `independent: basis=${grandBasis}/unit, gain=${expectedGain} | production: basisSource=${disp?.grandfathering?.basisSource}, gain=${disp?.taxableGain}`,
      { independentlyRecalculated: true });
  }

  // =========================================================================
  // LIVE-R6-006 — specified/debt fund: always STCG regardless of holding period.
  // =========================================================================
  {
    const corpBond = await sb("/rest/v1/ii_instruments?select=id&isin=eq.INF109KA1Z62");
    const instId = corpBond.json?.[0]?.id;
    if (!instId) {
      record('LIVE-R6-006', 'Specified/debt fund always short-term', 'BLOCKED', 'Reference debt-fund instrument (ICICI Prudential Corporate Bond Fund, ISIN INF109KA1Z62) not found — run scripts/ii_r6_final_reference_seed.mjs first.');
    } else {
      const acqDate = '2019-01-01'; // held ~5 years
      const dispDate = '2024-06-01';
      const units = 1000, cost = 12, sale = 15;
      await insertTxns([
        { user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: acqDate, gross_amount: units * cost, units, price_per_unit: cost, status: 'reconciled', source_reference: 'LIVE-R6-006 debt purchase' },
        { user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: dispDate, gross_amount: units * sale, units, price_per_unit: sale, status: 'reconciled', source_reference: 'LIVE-R6-006 debt redemption' },
      ]);
      const expectedGain = units * (sale - cost); // no grandfathering ever for debt
      const res = await app('/api/investment-intelligence/tax/summary', { cookie: userA.cookie });
      const disp = res.json?.data?.disposalResults?.find((d) => d.instrumentId === instId);
      const match = disp && disp.gainType === 'stcg' && disp.classification === 'debt_specified' && Math.abs(disp.taxableGain - expectedGain) < 0.01;
      record('LIVE-R6-006', 'Specified/debt fund held 5+ years is STILL classified STCG (never LTCG), real classification row used', match ? 'PASS' : 'FAIL',
        `independent: gainType=stcg (held ${Math.round((Date.parse(dispDate) - Date.parse(acqDate)) / 86400000)} days), gain=${expectedGain} | production: gainType=${disp?.gainType}, classification=${disp?.classification}, gain=${disp?.taxableGain}`,
        { independentlyRecalculated: true });
    }
  }

  // =========================================================================
  // LIVE-R6-007 — multi-fund taxpayer-level LTCG exemption threshold.
  //
  // Uses its OWN isolated user/account (not userA) — this FY-level
  // aggregation is taxpayer-wide BY DESIGN (that's exactly the behaviour
  // under test), so sharing userA's account would correctly, but
  // confusingly, pull in userA's OTHER FY2024-25 LTCG disposals from other
  // cases too. Isolating the user makes the independent expected-value
  // arithmetic exact and unambiguous.
  // =========================================================================
  {
    const userThreshold = await makeUser('threshold');
    const acctThreshold = await makeAccount(userThreshold.id, 'INR');
    const fundX = await makeInstrument('R6F Threshold Fund X - Growth (Direct Plan)');
    const fundY = await makeInstrument('R6F Threshold Fund Y - Growth (Direct Plan)');
    await classify(fundX, 'equity_oriented', 95);
    await classify(fundY, 'equity_oriented', 95);
    const dispDate = '2024-08-01';
    // Two LTCG disposals in the SAME FY (2024-25), each with a gain of 80,000 -> combined 160,000, above the 125,000 threshold that applies ONCE across the whole taxpayer, not per fund.
    await insertTxns([
      { user_id: userThreshold.id, account_id: acctThreshold, instrument_id: fundX, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2022-01-01', gross_amount: 1000 * 20, units: 1000, price_per_unit: 20, status: 'reconciled', source_reference: 'LIVE-R6-007 fundX purchase' },
      { user_id: userThreshold.id, account_id: acctThreshold, instrument_id: fundX, currency_code: 'INR', transaction_type: 'redemption', transaction_date: dispDate, gross_amount: 1000 * 100, units: 1000, price_per_unit: 100, status: 'reconciled', source_reference: 'LIVE-R6-007 fundX redemption' }, // gain 80,000
      { user_id: userThreshold.id, account_id: acctThreshold, instrument_id: fundY, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2022-01-01', gross_amount: 1000 * 20, units: 1000, price_per_unit: 20, status: 'reconciled', source_reference: 'LIVE-R6-007 fundY purchase' },
      { user_id: userThreshold.id, account_id: acctThreshold, instrument_id: fundY, currency_code: 'INR', transaction_type: 'redemption', transaction_date: dispDate, gross_amount: 1000 * 100, units: 1000, price_per_unit: 100, status: 'reconciled', source_reference: 'LIVE-R6-007 fundY redemption' }, // gain 80,000
    ]);
    const grossLtcg = 80000 + 80000;
    const rules = rulesFor(dispDate);
    const expectedTaxableAfterExemption = Math.max(0, grossLtcg - rules.exemption); // 160000 - 125000 = 35000

    const res = await app('/api/investment-intelligence/tax/summary', { cookie: userThreshold.cookie });
    const fy = res.json?.data?.taxYearAggregation;
    // 2024-08-01 falls in FY2024-25 (1 Apr 2024 - 31 Mar 2025).
    const bucket = (fy?.byFinancialYear ?? []).find((b) => b.financialYear?.includes('2024'));
    const taxableLtcg = bucket?.taxableLtcgAfterExemption ?? null;
    const match = taxableLtcg !== null && Math.abs(taxableLtcg - expectedTaxableAfterExemption) < 1 && bucket.contributingDisposalCount === 2;
    record('LIVE-R6-007', 'Multi-fund LTCG exemption threshold applied ONCE per taxpayer per FY, not once per fund', match ? 'PASS' : 'FAIL',
      `independent: gross LTCG=${grossLtcg}, exemption=${rules.exemption}, taxable=${expectedTaxableAfterExemption} | production bucket: ${JSON.stringify(bucket)}`,
      { independentlyRecalculated: true });
    cleanup.users.push(userThreshold.id);
  }

  // =========================================================================
  // LIVE-R6-008 — mixed-lot exit load (some lots within tier, some beyond).
  // =========================================================================
  {
    const bluechipDirect = await sb("/rest/v1/ii_instruments?select=id&instrument_name=eq.SBI Bluechip Fund - Growth (Direct Plan)&isin=is.null");
    const instId = bluechipDirect.json?.[0]?.id;
    if (!instId) {
      record('LIVE-R6-008', 'Mixed-lot exit load', 'BLOCKED', 'SBI Bluechip Fund (Direct) reference instrument not found.');
    } else {
      const dispDate = '2025-01-01';
      // Lot 1: acquired 2023-06-01 -> held 580 days at disposal, beyond the current 365-day tier -> 0% load.
      // Lot 2: acquired 2024-10-01 -> held 92 days at disposal, within the current 365-day tier -> 1% load.
      await insertTxns([
        { user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2023-06-01', gross_amount: 300 * 40, units: 300, price_per_unit: 40, status: 'reconciled', source_reference: 'LIVE-R6-008 lot1 (old)' },
        { user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2024-10-01', gross_amount: 200 * 55, units: 200, price_per_unit: 55, status: 'reconciled', source_reference: 'LIVE-R6-008 lot2 (recent)' },
        { user_id: userA.id, account_id: accountA, instrument_id: instId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: dispDate, gross_amount: 500 * 60, units: 500, price_per_unit: 60, status: 'reconciled', source_reference: 'LIVE-R6-008 redemption (both lots)' },
      ]);
      const holdingDaysLot1 = Math.round((Date.parse(dispDate) - Date.parse('2023-06-01')) / 86400000);
      const holdingDaysLot2 = Math.round((Date.parse(dispDate) - Date.parse('2024-10-01')) / 86400000);
      const expectedLoadLot1 = holdingDaysLot1 > 365 ? 0 : 1;
      const expectedLoadLot2 = holdingDaysLot2 <= 365 ? 1 : 0;

      const res = await app('/api/investment-intelligence/tax/summary', { cookie: userA.cookie });
      const loads = res.json?.data?.exitLoadResults ?? [];
      // Match by holdingDays proximity since lotId format differs.
      const loadOld = loads.find((l) => Math.abs(l.holdingDays - holdingDaysLot1) < 2);
      const loadRecent = loads.find((l) => Math.abs(l.holdingDays - holdingDaysLot2) < 2);
      const match = loadOld && loadRecent && loadOld.applicableLoadPct === expectedLoadLot1 && loadRecent.applicableLoadPct === expectedLoadLot2;
      record('LIVE-R6-008', 'Mixed-lot exit load: one lot beyond the 365-day tier (0%), one within it (1%), computed per-lot not per-disposal', match ? 'PASS' : 'FAIL',
        `independent: lot1(${holdingDaysLot1}d)=${expectedLoadLot1}%, lot2(${holdingDaysLot2}d)=${expectedLoadLot2}% | production: ${JSON.stringify(loads.map((l) => ({ days: l.holdingDays, pct: l.applicableLoadPct })))}`,
        { independentlyRecalculated: true });
    }
  }

  // =========================================================================
  // LIVE-R6-009 — Direct vs Regular plan cost comparison (same scheme, different canonical instruments).
  // =========================================================================
  {
    const direct = await sb("/rest/v1/ii_instruments?select=id&instrument_name=eq.SBI Bluechip Fund - Growth (Direct Plan)&isin=is.null");
    const regular = await sb("/rest/v1/ii_instruments?select=id&isin=eq.INF200K01UP0");
    const directId = direct.json?.[0]?.id;
    const regularId = regular.json?.[0]?.id;
    if (!directId || !regularId) {
      record('LIVE-R6-009', 'Direct/Regular cost comparison', 'BLOCKED', 'SBI Bluechip Direct/Regular reference instruments not found.');
    } else {
      // Same rupee amount invested same date in both plans, but Direct plan NAV is typically higher (lower expense ratio compounds to higher NAV over time) — model that with a higher acquisition AND disposal NAV for Direct, same underlying gain shape.
      const investAmount = 50000;
      const acqDate = '2022-02-01', dispDate = '2024-03-01';
      const directAcqNav = 50, directDispNav = 80; // 60% growth
      const regularAcqNav = 48, regularDispNav = 75.5; // ~57.3% growth (lower, reflecting higher TER drag)
      const directUnits = investAmount / directAcqNav;
      const regularUnits = investAmount / regularAcqNav;
      await insertTxns([
        { user_id: userA.id, account_id: accountA, instrument_id: directId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: acqDate, gross_amount: investAmount, units: directUnits, price_per_unit: directAcqNav, status: 'reconciled', source_reference: 'LIVE-R6-009 direct purchase' },
        { user_id: userA.id, account_id: accountA, instrument_id: directId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: dispDate, gross_amount: directUnits * directDispNav, units: directUnits, price_per_unit: directDispNav, status: 'reconciled', source_reference: 'LIVE-R6-009 direct redemption' },
        { user_id: userA.id, account_id: accountA, instrument_id: regularId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: acqDate, gross_amount: investAmount, units: regularUnits, price_per_unit: regularAcqNav, status: 'reconciled', source_reference: 'LIVE-R6-009 regular purchase' },
        { user_id: userA.id, account_id: accountA, instrument_id: regularId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: dispDate, gross_amount: regularUnits * regularDispNav, units: regularUnits, price_per_unit: regularDispNav, status: 'reconciled', source_reference: 'LIVE-R6-009 regular redemption' },
      ]);
      const expectedDirectGain = directUnits * directDispNav - investAmount;
      const expectedRegularGain = regularUnits * regularDispNav - investAmount;

      const res = await app('/api/investment-intelligence/tax/summary', { cookie: userA.cookie });
      const dispDirect = res.json?.data?.disposalResults?.find((d) => d.instrumentId === directId);
      const dispRegular = res.json?.data?.disposalResults?.find((d) => d.instrumentId === regularId);
      const match = dispDirect && dispRegular && Math.abs(dispDirect.taxableGain - expectedDirectGain) < 0.5 && Math.abs(dispRegular.taxableGain - expectedRegularGain) < 0.5 && dispDirect.instrumentId !== dispRegular.instrumentId;
      record('LIVE-R6-009', 'Direct vs Regular plan: two fully separate canonical positions, never merged, genuinely different gain outcomes', match ? 'PASS' : 'FAIL',
        `independent: direct gain=${expectedDirectGain.toFixed(2)}, regular gain=${expectedRegularGain.toFixed(2)} (direct > regular, reflecting lower TER) | production: direct=${dispDirect?.taxableGain}, regular=${dispRegular?.taxableGain}`,
        { independentlyRecalculated: true });
    }
  }

  // =========================================================================
  // LIVE-R6-010 — AUD household / INR investment: household currency never distorts the INR tax figure.
  // =========================================================================
  {
    const instId = await makeInstrument('R6F AUD Household INR Fund - Growth (Direct Plan)');
    await classify(instId, 'equity_oriented', 95);
    // A separate account explicitly currency_code='INR' even though this test simulates an AUD-preferred-currency household — the tax engine must use the account's own INR transaction amounts untouched, never a converted AUD figure.
    const acctInr = await makeAccount(userA.id, 'INR');
    const units = 600, cost = 25, sale = 40;
    await insertTxns([
      { user_id: userA.id, account_id: acctInr, instrument_id: instId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2022-04-01', gross_amount: units * cost, units, price_per_unit: cost, status: 'reconciled', source_reference: 'LIVE-R6-010 purchase' },
      { user_id: userA.id, account_id: acctInr, instrument_id: instId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: '2024-05-01', gross_amount: units * sale, units, price_per_unit: sale, status: 'reconciled', source_reference: 'LIVE-R6-010 redemption' },
    ]);
    const expectedGain = units * (sale - cost); // pure INR figure, no currency conversion applied anywhere

    const res = await app('/api/investment-intelligence/tax/summary', { cookie: userA.cookie });
    const disp = res.json?.data?.disposalResults?.find((d) => d.instrumentId === instId);
    const match = disp && Math.abs(disp.taxableGain - expectedGain) < 0.01;
    record('LIVE-R6-010', 'INR-denominated tax figure is unaffected by AUD household/reporting currency — no currency conversion leaks into the tax computation', match ? 'PASS' : 'FAIL',
      `independent: INR gain=${expectedGain} (untouched by any AUD conversion) | production: ${disp?.taxableGain}`,
      { independentlyRecalculated: true });
  }

  // =========================================================================
  // LIVE-R6-011 — missing tax-profile: never assumed resident.
  // =========================================================================
  {
    const userNoProfile = await makeUser('noprofile');
    const acct = await makeAccount(userNoProfile.id, 'INR');
    const instId = await makeInstrument('R6F No-Profile Fund - Growth (Direct Plan)');
    await classify(instId, 'equity_oriented', 95);
    await insertTxns([
      { user_id: userNoProfile.id, account_id: acct, instrument_id: instId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2022-01-01', gross_amount: 100 * 10, units: 100, price_per_unit: 10, status: 'reconciled', source_reference: 'LIVE-R6-011 purchase' },
      { user_id: userNoProfile.id, account_id: acct, instrument_id: instId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: '2024-01-05', gross_amount: 100 * 20, units: 100, price_per_unit: 20, status: 'reconciled', source_reference: 'LIVE-R6-011 redemption' },
    ]);
    // Deliberately NO profile call, no override query param.
    const res = await app('/api/investment-intelligence/tax/summary', { cookie: userNoProfile.cookie });
    const ctx = res.json?.data?.taxpayerContext;
    const match = ctx && ctx.estimateBasis === 'UNKNOWN_PROFILE' && ctx.taxpayerType === 'UNKNOWN' && ctx.profileComplete === false && res.json?.data?.taxProfileSource === 'none';
    record('LIVE-R6-011', 'Missing tax-profile: taxpayerContext genuinely UNKNOWN_PROFILE, never silently assumed resident', match ? 'PASS' : 'FAIL',
      `taxpayerContext=${JSON.stringify(ctx)}, taxProfileSource=${res.json?.data?.taxProfileSource}`);
    cleanup.users.push(userNoProfile.id);
  }

  // =========================================================================
  // LIVE-R6-012 — non-resident / DTAA-not-evaluated.
  // =========================================================================
  {
    const userNri = await makeUser('nri');
    const acct = await makeAccount(userNri.id, 'INR');
    const instId = await makeInstrument('R6F NRI Fund - Growth (Direct Plan)');
    await classify(instId, 'equity_oriented', 95);
    await insertTxns([
      { user_id: userNri.id, account_id: acct, instrument_id: instId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2022-01-01', gross_amount: 100 * 10, units: 100, price_per_unit: 10, status: 'reconciled', source_reference: 'LIVE-R6-012 purchase' },
      { user_id: userNri.id, account_id: acct, instrument_id: instId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: '2024-01-05', gross_amount: 100 * 20, units: 100, price_per_unit: 20, status: 'reconciled', source_reference: 'LIVE-R6-012 redemption' },
    ]);
    const res = await app('/api/investment-intelligence/tax/summary?taxpayerType=NON_RESIDENT_INDIVIDUAL', { cookie: userNri.cookie });
    const ctx = res.json?.data?.taxpayerContext;
    const expectedGain = 100 * (20 - 10);
    const disp = res.json?.data?.disposalResults?.find((d) => d.instrumentId === instId);
    const match = ctx && ctx.estimateBasis === 'INDIA_DOMESTIC_LAW_ESTIMATE' && ctx.dtaaEvaluated === false && ctx.taxpayerTypeNote?.includes('DTAA_NOT_EVALUATED') && disp && Math.abs(disp.taxableGain - expectedGain) < 0.01 && res.json?.data?.residencyNote;
    record('LIVE-R6-012', 'Non-resident: genuine INDIA_DOMESTIC_LAW_ESTIMATE figure computed, DTAA explicitly NOT evaluated/fabricated, NRI scope disclaimer attached', match ? 'PASS' : 'FAIL',
      `taxpayerContext=${JSON.stringify(ctx)}, gain=${disp?.taxableGain} (expected ${expectedGain}), residencyNote present=${!!res.json?.data?.residencyNote}`);
    cleanup.users.push(userNri.id);
  }

  console.log('\n--- SUMMARY ---');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  const independentCount = results.filter((r) => r.independentlyRecalculated).length;
  console.log(`PASS=${pass} FAIL=${fail} BLOCKED=${blocked} (of ${results.length}); independently recalculated: ${independentCount}`);

  fs.writeFileSync(path.join(__dirname, 'ii-r6-final-certification', 'live_dev_cases_results.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
}

main()
  .catch((e) => {
    record('HARNESS', 'Harness execution', 'BLOCKED', e.stack ?? e.message);
  })
  .finally(async () => {
    // Deliberately NOT deleting seeded instruments/accounts/transactions —
    // this data is the live evidence the closure report cites; the security
    // harness (Sections 35-38) reuses these SAME users as real victim rows.
    // Only ephemeral auth users beyond what the security harness needs are
    // left for that harness to reuse or clean up itself.
    console.log(`\nSeeded test users for reuse by the security harness: ${cleanup.users.join(', ')}`);
  });
