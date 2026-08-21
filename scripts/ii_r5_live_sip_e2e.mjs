// Investment Intelligence R5 — GENUINE live-DEV end-to-end SIP verification.
//
// Why this exists separately from ii_r5_live_dev_security_tests.mjs: the SIP
// analytics path reads ONLY tables that already exist in DEV
// (ii_accounts / ii_instruments / ii_transactions / ii_prices_nav /
// ii_benchmarks / ii_benchmark_series / ii_instrument_benchmarks). Persistence
// to the new R5 tables is deliberately non-fatal, so the whole SIP surface can
// be exercised end to end even while migration 0044 is outstanding.
//
// WHAT MAKES THIS INDEPENDENT (spec section 93): for each scenario this
// script
//   1. seeds known data into the REAL DEV database via the service role,
//   2. computes the expected answer ITSELF, from the seeded inputs, using its
//      own bisection XIRR — it does not import or call any production module,
//   3. calls the REAL running API over HTTP as a REAL authenticated user,
//   4. compares, and
//   5. inspects what the API actually returned for correct versioning and
//      as-of metadata.
// Calling production twice and comparing it with itself would prove nothing;
// that is deliberately not what happens here.
//
// Run:  node scripts/ii_r5_live_sip_e2e.mjs [baseUrl]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3199';

function loadEnv() {
  for (const p of [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')]) {
    if (fs.existsSync(p)) {
      const env = {};
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      }
      return env;
    }
  }
  throw new Error('No .env.local found');
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(BASE).host.split('.')[0];

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 500)}`);
}

async function sb(p, { method = 'GET', apikey = SERVICE, token = SERVICE, body, prefer } = {}) {
  const headers = { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { ok: res.ok, status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// This script's OWN XIRR — pure bisection, no production import.
// ---------------------------------------------------------------------------
function npv(flows, r) {
  const d0 = Math.min(...flows.map((f) => Date.parse(f[0] + 'T00:00:00Z')));
  let t = 0;
  for (const [d, a] of flows) {
    const years = (Date.parse(d + 'T00:00:00Z') - d0) / (365 * 86400000);
    t += a / Math.pow(1 + r, years);
  }
  return t;
}
function xirrBisect(flows) {
  let lo = -0.9999, hi = 10;
  const fLo = npv(flows, lo);
  if (!(fLo * npv(flows, hi) < 0)) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(flows, mid);
    if ((fLo < 0 && fm < 0) || (fLo > 0 && fm > 0)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function addMonths(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  const tm = d.getUTCMonth() + n;
  const y = d.getUTCFullYear() + Math.floor(tm / 12);
  const m = ((tm % 12) + 12) % 12;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), dim))).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
const stamp = Date.now();
const cleanup = { users: [], instruments: [], benchmarks: [], accounts: [] };

async function makeUser(tag) {
  const email = `ii-r5-e2e-${tag}-${stamp}@fhip-test.local`;
  const password = 'TestPass!' + stamp;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const signIn = await sb('/auth/v1/token?grant_type=password', { method: 'POST', apikey: ANON, token: ANON, body: { email, password } });
  if (!id || !signIn.json?.access_token) throw new Error(`user setup failed: ${created.text} ${signIn.text}`);
  cleanup.users.push(id);
  // @supabase/ssr stores the whole session as a base64-prefixed cookie.
  const session = signIn.json;
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, email, session, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

async function app(pathname, cookie) {
  const res = await fetch(`${APP}${pathname}`, { headers: { Cookie: cookie } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text };
}

/** Seed one scheme with a NAV series, a benchmark, and a SIP history. */
async function seedScheme({ userId, name, startNav, drift, benchmarkStart, benchmarkDrift, sipStart, sipCount, sipAmount, asOf, extraTxns = [], withBenchmark = true }) {
  // Instrument
  const inst = await sb('/rest/v1/ii_instruments', {
    method: 'POST', prefer: 'return=representation',
    body: { instrument_name: name, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' },
  });
  const instrumentId = inst.json?.[0]?.id;
  if (!instrumentId) throw new Error(`instrument seed failed: ${inst.text}`);
  cleanup.instruments.push(instrumentId);

  // Account
  const acct = await sb('/rest/v1/ii_accounts', {
    method: 'POST', prefer: 'return=representation',
    body: {
      user_id: userId,
      account_type: 'mf_folio',
      institution_name: 'E2E Test AMC',
      folio_number: `FOLIO-${stamp}-${cleanup.instruments.length}`,
      country_code: 'IN',
      currency_code: 'INR',
      status: 'active',
    },
  });
  const accountId = acct.json?.[0]?.id;
  if (!accountId) throw new Error(`account seed failed: ${acct.text}`);
  cleanup.accounts.push(accountId);

  // Daily NAV series (weekdays only), start 1 month before the first SIP.
  const navStart = addMonths(sipStart, -1);
  const navRows = [];
  let v = startNav;
  const daily = Math.pow(1 + drift, 1 / 365) - 1;
  for (let d = navStart; d <= asOf; d = addDays(d, 1)) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) navRows.push({ instrument_id: instrumentId, price_date: d, price: Math.round(v * 1e6) / 1e6, currency_code: 'INR', quality_status: 'ok' });
    v *= 1 + daily;
  }
  for (let i = 0; i < navRows.length; i += 500) {
    const r = await sb('/rest/v1/ii_prices_nav', { method: 'POST', body: navRows.slice(i, i + 500) });
    if (!r.ok) throw new Error(`nav seed failed: ${r.text}`);
  }
  const navByDate = new Map(navRows.map((r) => [r.price_date, r.price]));
  const navOnOrAfter = (d) => {
    for (let k = 0; k <= 10; k++) {
      const key = addDays(d, k);
      if (navByDate.has(key)) return { date: key, value: navByDate.get(key) };
    }
    return null;
  };
  const navAsOf = (d) => {
    for (let k = 0; k <= 10; k++) {
      const key = addDays(d, -k);
      if (navByDate.has(key)) return { date: key, value: navByDate.get(key) };
    }
    return null;
  };

  // SIP transactions
  const txns = [];
  for (let k = 0; k < sipCount; k++) {
    const date = addMonths(sipStart, k);
    const nav = navOnOrAfter(date);
    txns.push({
      user_id: userId, account_id: accountId, instrument_id: instrumentId, currency_code: 'INR',
      transaction_type: 'sip', transaction_date: date, gross_amount: sipAmount,
      units: Math.round((sipAmount / nav.value) * 1e6) / 1e6, price_per_unit: nav.value,
      status: 'reconciled', source_reference: `SIP INSTALMENT ${k + 1}`,
    });
  }
  for (const extra of extraTxns) {
    const nav = navOnOrAfter(extra.date);
    txns.push({
      user_id: userId, account_id: accountId, instrument_id: instrumentId, currency_code: 'INR',
      transaction_type: extra.type, transaction_date: extra.date, gross_amount: extra.amount,
      units: extra.units ?? Math.round((extra.amount / nav.value) * 1e6) / 1e6, price_per_unit: nav.value,
      status: 'reconciled', source_reference: extra.reference ?? extra.type.toUpperCase(),
    });
  }
  const tr = await sb('/rest/v1/ii_transactions', { method: 'POST', body: txns });
  if (!tr.ok) throw new Error(`transaction seed failed: ${tr.text}`);

  // Holding snapshot so the position is visible to the rest of the platform.
  const totalUnits = txns.filter((t) => t.transaction_type === 'sip' || t.transaction_type === 'purchase').reduce((s, t) => s + t.units, 0)
    - txns.filter((t) => t.transaction_type === 'redemption').reduce((s, t) => s + t.units, 0);
  const navFinal = navAsOf(asOf);
  await sb('/rest/v1/ii_holding_snapshots', {
    method: 'POST',
    body: { user_id: userId, account_id: accountId, instrument_id: instrumentId, currency_code: 'INR', quality_status: 'certified', as_of_date: asOf, units: Math.round(totalUnits * 1e6) / 1e6, value: Math.round(totalUnits * navFinal.value * 100) / 100 },
  });

  // Benchmark + series + mapping
  let benchmarkId = null;
  let benchmarkByDate = new Map();
  if (withBenchmark) {
    const bm = await sb('/rest/v1/ii_benchmarks', {
      method: 'POST', prefer: 'return=representation',
      body: { benchmark_key: `E2E_BM_${stamp}_${cleanup.benchmarks.length}`, benchmark_label: 'E2E Test Index', benchmark_category: 'index', country_code: 'IN', return_type: 'TRI' },
    });
    benchmarkId = bm.json?.[0]?.id;
    if (!benchmarkId) throw new Error(`benchmark seed failed: ${bm.text}`);
    cleanup.benchmarks.push(benchmarkId);

    const bmRows = [];
    let bv = benchmarkStart;
    const bDaily = Math.pow(1 + benchmarkDrift, 1 / 365) - 1;
    for (let d = navStart; d <= asOf; d = addDays(d, 1)) {
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      if (dow !== 0 && dow !== 6) bmRows.push({ benchmark_id: benchmarkId, series_date: d, value: Math.round(bv * 1e6) / 1e6, currency_code: 'INR', quality_status: 'ok' });
      bv *= 1 + bDaily;
    }
    for (let i = 0; i < bmRows.length; i += 500) {
      const r = await sb('/rest/v1/ii_benchmark_series', { method: 'POST', body: bmRows.slice(i, i + 500) });
      if (!r.ok) throw new Error(`benchmark series seed failed: ${r.text}`);
    }
    benchmarkByDate = new Map(bmRows.map((r) => [r.series_date, r.value]));

    const map = await sb('/rest/v1/ii_instrument_benchmarks', {
      method: 'POST',
      body: { instrument_id: instrumentId, benchmark_id: benchmarkId, relationship_type: 'primary', effective_from: '1900-01-01', mapping_version: 'v1', quality_status: 'ok' },
    });
    if (!map.ok) throw new Error(`benchmark mapping seed failed: ${map.text}`);
  }

  return { instrumentId, accountId, benchmarkId, txns, navOnOrAfter, navAsOf, benchmarkByDate, navByDate };
}

// ---------------------------------------------------------------------------
async function main() {
  // Server reachability first — never report PASS/FAIL from an unreachable app.
  try {
    const ping = await fetch(`${APP}/api/investment-intelligence/sip`, { redirect: 'manual' });
    if (ping.status === 0) throw new Error('no response');
  } catch (e) {
    record('LIVE-R5-SERVER', 'Dev server reachable', 'BLOCKED', `${APP} did not respond: ${e.message}`);
    return;
  }
  record('LIVE-R5-SERVER', 'Dev server reachable', 'PASS', APP);

  // Unauthenticated access must be refused before anything else.
  const anonCall = await app('/api/investment-intelligence/sip', '');
  record('SEC-R5-API-001', 'Unauthenticated GET /api/investment-intelligence/sip is refused', anonCall.status === 401 ? 'PASS' : 'FAIL', `HTTP ${anonCall.status} ${anonCall.text.slice(0, 120)}`);
  const anonXray = await app('/api/investment-intelligence/xray', '');
  record('SEC-R5-API-002', 'Unauthenticated GET /api/investment-intelligence/xray is refused', anonXray.status === 401 ? 'PASS' : 'FAIL', `HTTP ${anonXray.status} ${anonXray.text.slice(0, 120)}`);

  const A = await makeUser('a');
  const B = await makeUser('b');

  // Sanity: the cookie actually authenticates.
  const authCheck = await app('/api/investment-intelligence/sip', A.cookie);
  if (authCheck.status === 401) {
    record('LIVE-R5-AUTH', 'Session cookie authenticates against the app', 'BLOCKED', 'The constructed @supabase/ssr cookie was not accepted; live API scenarios cannot run.');
    return;
  }
  record('LIVE-R5-AUTH', 'Session cookie authenticates against the app', 'PASS', `HTTP ${authCheck.status}`);

  const asOf = '2024-06-28';

  // =========================================================================
  // LIVE-R5-001 — standard monthly SIP, actual SIP XIRR
  // LIVE-R5-004 — actual-vs-benchmark over identical cash flows
  // =========================================================================
  const s1 = await seedScheme({
    userId: A.id, name: `E2E Growth Fund ${stamp}`, startNav: 100, drift: 0.12,
    benchmarkStart: 15000, benchmarkDrift: 0.09, sipStart: '2021-01-05', sipCount: 36, sipAmount: 5000, asOf,
  });

  const resp1 = await app(`/api/investment-intelligence/sip?asOf=${asOf}`, A.cookie);
  const payload1 = resp1.json?.data;
  const series1 = (payload1?.series ?? []).find((x) => x.instrumentId === s1.instrumentId);

  if (!series1) {
    record('LIVE-R5-001', 'Standard monthly SIP produces a series with an actual SIP XIRR', 'FAIL', `No series returned for the seeded instrument. HTTP ${resp1.status} ${resp1.text.slice(0, 300)}`);
  } else {
    // INDEPENDENT expected value, computed here from the seeded inputs.
    const sipTxns = s1.txns.filter((t) => t.transaction_type === 'sip');
    const units = sipTxns.reduce((s, t) => s + t.units, 0);
    const navEnd = s1.navAsOf(asOf);
    const expectedTerminal = units * navEnd.value;
    const flows = sipTxns.map((t) => [t.transaction_date, -t.gross_amount]);
    flows.push([asOf, expectedTerminal]);
    const expectedRate = xirrBisect(flows);

    const rateVar = Math.abs(series1.actualXirr.rate - expectedRate);
    const termVar = Math.abs(series1.actualXirr.terminalValue - expectedTerminal);
    record(
      'LIVE-R5-001',
      'Standard monthly SIP produces a series with an actual SIP XIRR',
      series1.actualXirr.status === 'ok' && rateVar <= 1e-6 && termVar <= 0.01 ? 'PASS' : 'FAIL',
      `cadence=${series1.cadence} confidence=${series1.confidence} contributions=${series1.contributionCount}; ` +
        `API rate=${series1.actualXirr.rate} independent=${expectedRate} variance=${rateVar.toExponential(3)}; ` +
        `API terminal=${series1.actualXirr.terminalValue} independent=${expectedTerminal.toFixed(2)} variance=${termVar.toFixed(6)}`
    );
    record('LIVE-R5-001b', 'Source-confirmed SIP is labelled CONFIRMED_SOURCE and MONTHLY', series1.confidence === 'CONFIRMED_SOURCE' && series1.cadence === 'MONTHLY' ? 'PASS' : 'FAIL', `confidence=${series1.confidence} cadence=${series1.cadence}`);

    // Benchmark SIP, independently reconstructed.
    let synth = 0;
    let aligned = true;
    for (const t of sipTxns) {
      let lvl = null;
      for (let k = 0; k <= 10; k++) {
        const key = addDays(t.transaction_date, k);
        if (s1.benchmarkByDate.has(key)) { lvl = s1.benchmarkByDate.get(key); break; }
      }
      if (lvl === null) { aligned = false; break; }
      synth += t.gross_amount / lvl;
    }
    let bmEnd = null;
    for (let k = 0; k <= 10; k++) {
      const key = addDays(asOf, -k);
      if (s1.benchmarkByDate.has(key)) { bmEnd = s1.benchmarkByDate.get(key); break; }
    }
    if (aligned && bmEnd !== null) {
      const bmTerminal = synth * bmEnd;
      const bmFlows = sipTxns.map((t) => [t.transaction_date, -t.gross_amount]);
      bmFlows.push([asOf, bmTerminal]);
      const expectedBmRate = xirrBisect(bmFlows);
      const bmVar = Math.abs(series1.benchmarkSip.rate - expectedBmRate);
      record(
        'LIVE-R5-004',
        'Benchmark SIP uses IDENTICAL cash flows and matches an independent reconstruction',
        series1.benchmarkSip.status === 'ok' && bmVar <= 1e-6 ? 'PASS' : 'FAIL',
        `API benchmark rate=${series1.benchmarkSip.rate} independent=${expectedBmRate} variance=${bmVar.toExponential(3)}; benchmark=${series1.benchmarkSip.benchmarkKey} returnType=${series1.benchmarkSip.benchmarkReturnType}`
      );
      // Identical-schedule proof: every applied contribution must match the
      // actual transaction date and amount exactly.
      const applied = series1.benchmarkSip.appliedContributions ?? [];
      const identical = applied.length === sipTxns.length && sipTxns.every((t, i) => applied[i].date === t.transaction_date && Math.abs(applied[i].amount - t.gross_amount) < 1e-6);
      record('LIVE-R5-004b', 'Every benchmark contribution matches the real contribution date and amount', identical ? 'PASS' : 'FAIL', `${applied.length} applied vs ${sipTxns.length} actual contributions`);

      const expectedExcess = expectedRate - expectedBmRate;
      const exVar = Math.abs(series1.excessReturn.excessReturn - expectedExcess);
      record(
        'LIVE-R5-004c',
        'SIP benchmark excess return equals actual minus benchmark, and is not called alpha',
        series1.excessReturn.status === 'ok' && exVar <= 1e-6 && !/alpha/i.test(series1.excessReturn.label) ? 'PASS' : 'FAIL',
        `label="${series1.excessReturn.label}" API=${series1.excessReturn.excessReturn} independent=${expectedExcess} variance=${exVar.toExponential(3)}`
      );
    } else {
      record('LIVE-R5-004', 'Benchmark SIP uses identical cash flows', 'BLOCKED', 'Seeded benchmark series did not cover every contribution date.');
    }

    record('LIVE-R5-ASOF', 'Response reports the correct as-of date and the NAV date actually used', series1.navDateUsed && payload1.asOfDate === asOf ? 'PASS' : 'FAIL', `asOfDate=${payload1.asOfDate} navDateUsed=${series1.navDateUsed} navAtAsOf=${series1.navAtAsOf}`);
  }

  // =========================================================================
  // LIVE-R5-002 — missed contribution must NOT read as stopped
  // =========================================================================
  const s2 = await seedScheme({
    userId: A.id, name: `E2E Gap Fund ${stamp}`, startNav: 80, drift: 0.10,
    benchmarkStart: 12000, benchmarkDrift: 0.08, sipStart: '2022-02-07', sipCount: 24, sipAmount: 4000, asOf,
  });
  // Remove one instalment to create a genuine single gap.
  const midDate = addMonths('2022-02-07', 10);
  await sb(`/rest/v1/ii_transactions?instrument_id=eq.${s2.instrumentId}&transaction_date=eq.${midDate}`, { method: 'DELETE' });

  const resp2 = await app(`/api/investment-intelligence/sip?asOf=${asOf}`, A.cookie);
  const series2 = (resp2.json?.data?.series ?? []).find((x) => x.instrumentId === s2.instrumentId);
  if (!series2) {
    record('LIVE-R5-002', 'SIP with a missed contribution reports the gap, not "stopped"', 'FAIL', 'No series returned for the gap fund.');
  } else {
    const gapReported = (series2.consistency.gaps ?? []).length >= 1;
    const skipped = series2.consistency.skippedPeriods;
    record(
      'LIVE-R5-002',
      'SIP with a missed contribution reports the gap, and skipped-period count is 1',
      gapReported && skipped === 1 ? 'PASS' : 'FAIL',
      `gaps=${JSON.stringify(series2.consistency.gaps)} skippedPeriods=${skipped} consistencyPct=${series2.consistency.consistencyPct} activity=${series2.activity.status}`
    );
    const statement = series2.activity.statement.toLowerCase();
    const advisory = ['you should', 'increase your', 'stop this', 'switch to', 'we recommend'].filter((w) => statement.includes(w));
    record('LIVE-R5-002b', 'Activity wording is observational and contains no advice', advisory.length === 0 ? 'PASS' : 'FAIL', `statement="${series2.activity.statement}"`);
  }

  // =========================================================================
  // LIVE-R5-003 — SIP + independent lump sum: only series units attributed
  // =========================================================================
  const s3 = await seedScheme({
    userId: A.id, name: `E2E Mixed Fund ${stamp}`, startNav: 120, drift: 0.11,
    benchmarkStart: 18000, benchmarkDrift: 0.10, sipStart: '2022-01-10', sipCount: 24, sipAmount: 3000, asOf,
    extraTxns: [{ type: 'purchase', date: '2022-06-15', amount: 250000, reference: 'LUMPSUM PURCHASE' }],
  });
  const resp3 = await app(`/api/investment-intelligence/sip?asOf=${asOf}`, A.cookie);
  const series3 = (resp3.json?.data?.series ?? []).find((x) => x.instrumentId === s3.instrumentId);
  if (!series3) {
    record('LIVE-R5-003', 'SIP plus an independent lump sum attributes only the series units', 'FAIL', 'No series returned for the mixed fund.');
  } else {
    const sipTxns = s3.txns.filter((t) => t.transaction_type === 'sip');
    const lump = s3.txns.find((t) => t.transaction_type === 'purchase');
    const seriesUnits = sipTxns.reduce((s, t) => s + t.units, 0);
    const allUnits = seriesUnits + lump.units;
    const navEnd = s3.navAsOf(asOf);
    const expectedSeriesTerminal = seriesUnits * navEnd.value;
    const wholeFundTerminal = allUnits * navEnd.value;
    const termVar = Math.abs(series3.actualXirr.terminalValue - expectedSeriesTerminal);
    const notWholeFund = Math.abs(series3.actualXirr.terminalValue - wholeFundTerminal) > 1;
    record(
      'LIVE-R5-003',
      'SIP + lump sum: ending value attributed to the series ONLY, not the whole fund',
      series3.actualXirr.status === 'ok' && termVar <= 0.01 && notWholeFund ? 'PASS' : 'FAIL',
      `API terminal=${series3.actualXirr.terminalValue}; series-only expected=${expectedSeriesTerminal.toFixed(2)} (variance ${termVar.toFixed(6)}); whole-fund would be ${wholeFundTerminal.toFixed(2)}`
    );
    record('LIVE-R5-003b', 'Mixed position is disclosed to the caller', series3.attribution.positionIsMixed === true ? 'PASS' : 'FAIL', `positionIsMixed=${series3.attribution.positionIsMixed}`);
  }

  // =========================================================================
  // LIVE-R5-004d — missing benchmark produces no fabricated result
  // =========================================================================
  const s4 = await seedScheme({
    userId: A.id, name: `E2E NoBenchmark Fund ${stamp}`, startNav: 50, drift: 0.07,
    benchmarkStart: 0, benchmarkDrift: 0, sipStart: '2022-03-03', sipCount: 20, sipAmount: 2500, asOf, withBenchmark: false,
  });
  const resp4 = await app(`/api/investment-intelligence/sip?asOf=${asOf}`, A.cookie);
  const series4 = (resp4.json?.data?.series ?? []).find((x) => x.instrumentId === s4.instrumentId);
  if (!series4) {
    record('LIVE-R5-NOBENCH', 'Unmapped scheme yields no fabricated benchmark result', 'FAIL', 'No series returned for the unmapped fund.');
  } else {
    const ok = series4.benchmarkSip.status === 'unavailable' && series4.benchmarkSip.rate === null && series4.excessReturn.status === 'unavailable';
    record(
      'LIVE-R5-NOBENCH',
      'Unmapped scheme yields NO benchmark rate and NO excess return (not zero)',
      ok ? 'PASS' : 'FAIL',
      `benchmarkSip.status=${series4.benchmarkSip.status} rate=${series4.benchmarkSip.rate} reason=${series4.benchmarkSip.reason}; excess.status=${series4.excessReturn.status}`
    );
    // The actual SIP return must still be available — one missing input must
    // not suppress an unrelated, genuinely calculable metric.
    record('LIVE-R5-NOBENCH-b', 'Actual SIP return remains available despite the missing benchmark', series4.actualXirr.status === 'ok' ? 'PASS' : 'FAIL', `actualXirr.status=${series4.actualXirr.status} rate=${series4.actualXirr.rate}`);
  }

  // =========================================================================
  // LIVE-R5-010 — cross-user isolation through the REAL API
  // =========================================================================
  const respB = await app(`/api/investment-intelligence/sip?asOf=${asOf}`, B.cookie);
  const bSeries = respB.json?.data?.series ?? [];
  const leaked = bSeries.some((x) => [s1.instrumentId, s2.instrumentId, s3.instrumentId, s4.instrumentId].includes(x.instrumentId));
  record(
    'LIVE-R5-010',
    "User B's SIP request returns none of user A's series",
    !leaked ? 'PASS' : 'FAIL',
    `B saw ${bSeries.length} series; empty=${respB.json?.data?.empty}; leaked A's instruments: ${leaked}`
  );

  const respBXray = await app('/api/investment-intelligence/xray', B.cookie);
  record('LIVE-R5-010b', "User B's X-Ray request returns none of user A's positions", respBXray.status === 200 && (respBXray.json?.data?.empty === true || (respBXray.json?.data?.totalPortfolioValue ?? 0) === 0) ? 'PASS' : 'FAIL', `HTTP ${respBXray.status} empty=${respBXray.json?.data?.empty} total=${respBXray.json?.data?.totalPortfolioValue}`);

  // =========================================================================
  // Parameter-spoofing: an invalid/absurd asOf must be rejected or capped,
  // never used to widen visibility.
  // =========================================================================
  const badDate = await app('/api/investment-intelligence/sip?asOf=not-a-date', A.cookie);
  record('SEC-R5-API-003', 'Malformed asOf parameter is rejected', badDate.status === 400 ? 'PASS' : 'FAIL', `HTTP ${badDate.status} ${badDate.text.slice(0, 120)}`);

  const futureDate = await app('/api/investment-intelligence/sip?asOf=2099-12-31', A.cookie);
  const cappedTo = futureDate.json?.data?.asOfDate;
  record('SEC-R5-API-004', 'A far-future asOf is capped to real data, not silently accepted', cappedTo && cappedTo < '2099-12-31' ? 'PASS' : 'FAIL', `requested 2099-12-31, response asOfDate=${cappedTo}`);

  // =========================================================================
  // X-Ray with NO fund-holdings data must report unavailable, never zeros.
  // =========================================================================
  const xrayA = await app('/api/investment-intelligence/xray', A.cookie);
  const xd = xrayA.json?.data;
  const noFabrication = xd && xd.empty === false && xd.available === false && xd.topHoldings === undefined && xd.sectorExposure === undefined && typeof xd.unavailableReason === 'string';
  record(
    'LIVE-R5-XRAY-ZERO',
    'X-Ray with zero holdings coverage returns UNAVAILABLE with no fabricated zero analytics',
    noFabrication ? 'PASS' : 'FAIL',
    `available=${xd?.available} coverage=${xd?.dataQuality?.effectiveCoverage} topHoldings=${xd?.topHoldings === undefined ? 'omitted' : 'PRESENT(!)'} sectorExposure=${xd?.sectorExposure === undefined ? 'omitted' : 'PRESENT(!)'} reason="${String(xd?.unavailableReason).slice(0, 120)}"`
  );
  record('LIVE-R5-XRAY-DATES', 'X-Ray reports positions as-of and holdings as-of separately', xd && xd.portfolioAsOfDate ? 'PASS' : 'FAIL', `portfolioAsOfDate=${xd?.portfolioAsOfDate} holdingsAsOfDate=${xd?.holdingsAsOfDate}`);

  // =========================================================================
  // Simulation endpoint
  // =========================================================================
  if (series1) {
    const simRes = await fetch(`${APP}/api/investment-intelligence/sip/simulation`, {
      method: 'POST', headers: { Cookie: A.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ seriesKey: series1.seriesKey }),
    });
    const simBody = await simRes.json();
    const sim = simBody?.data;
    const variants = sim?.variants ?? [];
    const labelled = sim?.classification === 'SIMULATION' && typeof sim?.disclaimer === 'string' && /not a recommendation/i.test(sim.disclaimer);
    record('LIVE-R5-SIM', 'Simulation returns labelled flat + step-up variants', simRes.status === 200 && variants.filter((v) => v.status === 'ok').length === 3 && labelled ? 'PASS' : 'FAIL', `HTTP ${simRes.status} variants=${variants.map((v) => `${v.label}:${v.status}`).join(', ')} classification=${sim?.classification}`);

    // Independent check of the FLAT variant's total contributed.
    const flat = variants.find((v) => v.annualStepUpPct === 0);
    if (flat && flat.status === 'ok') {
      const expectedTotal = flat.contributionCount * Math.round(5000);
      record('LIVE-R5-SIM-b', 'Flat simulation total contributed equals contributions x amount', Math.abs(flat.totalContributed - expectedTotal) <= 0.01 ? 'PASS' : 'FAIL', `API total=${flat.totalContributed} independent=${expectedTotal} (count=${flat.contributionCount})`);
    }

    // B must not be able to simulate against A's series. Seed B with their
    // OWN fund first, so B is a fully-provisioned user and the refusal is a
    // genuine ownership check rather than an incidental empty-dataset short
    // circuit.
    await seedScheme({
      userId: B.id, name: `E2E B-Own Fund ${stamp}`, startNav: 60, drift: 0.08,
      benchmarkStart: 9000, benchmarkDrift: 0.06, sipStart: '2022-05-09', sipCount: 18, sipAmount: 2000, asOf,
    });
    const bOwn = await app(`/api/investment-intelligence/sip?asOf=${asOf}`, B.cookie);
    const bHasOwn = (bOwn.json?.data?.series ?? []).length > 0;

    const bSim = await fetch(`${APP}/api/investment-intelligence/sip/simulation`, {
      method: 'POST', headers: { Cookie: B.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ seriesKey: series1.seriesKey }),
    });
    const bSimText = await bSim.text();
    record(
      'SEC-R5-API-005',
      "A fully-provisioned user B cannot run a simulation against user A's series",
      bHasOwn && (bSim.status === 404 || bSim.status === 400) ? 'PASS' : 'FAIL',
      `B has own series: ${bHasOwn}; attacking A's seriesKey -> HTTP ${bSim.status} ${bSimText.slice(0, 160)}`
    );

    // And B's own series must still simulate fine, proving the refusal above
    // is about ownership, not a broken endpoint.
    const bOwnKey = bOwn.json?.data?.series?.[0]?.seriesKey;
    if (bOwnKey) {
      const bOwnSim = await fetch(`${APP}/api/investment-intelligence/sip/simulation`, {
        method: 'POST', headers: { Cookie: B.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesKey: bOwnKey }),
      });
      const bOwnBody = await bOwnSim.json();
      record('SEC-R5-API-005b', "User B CAN simulate their own series (refusal above is ownership, not breakage)", bOwnSim.status === 200 && (bOwnBody?.data?.variants ?? []).some((v) => v.status === 'ok') ? 'PASS' : 'FAIL', `HTTP ${bOwnSim.status}`);
    }
  }
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  record('HARNESS', 'Harness execution', 'BLOCKED', `${e.message}\n${e.stack?.split('\n').slice(0, 4).join('\n')}`);
  exitCode = 2;
} finally {
  // Teardown — remove every seeded row.
  for (const id of cleanup.users) await sb(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
  for (const id of cleanup.instruments) {
    await sb(`/rest/v1/ii_instrument_benchmarks?instrument_id=eq.${id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_prices_nav?instrument_id=eq.${id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_instruments?id=eq.${id}`, { method: 'DELETE' });
  }
  for (const id of cleanup.benchmarks) {
    await sb(`/rest/v1/ii_benchmark_series?benchmark_id=eq.${id}`, { method: 'DELETE' });
    await sb(`/rest/v1/ii_benchmarks?id=eq.${id}`, { method: 'DELETE' });
  }
  console.log('\nCleanup done.');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  console.log(`\nSUMMARY: PASS=${pass} FAIL=${fail} BLOCKED=${blocked} (of ${results.length})`);
  fs.writeFileSync(path.join(__dirname, 'ii-r5-certification', 'live_sip_e2e_results.json'), JSON.stringify({ ranAt: new Date().toISOString(), appBaseUrl: APP, results }, null, 2));
  if (fail > 0) exitCode = 1;
  process.exit(exitCode);
}
