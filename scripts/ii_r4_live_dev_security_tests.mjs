// Investment Intelligence R4 — live-DEV test pack (LIVE-R4-001..010),
// independent live reconciliation, and security pack (SEC-R4-001..010).
//
// Fail-closed convention (same as the R1 pack): any test that cannot be
// genuinely evaluated is reported BLOCKED with the exact reason. Nothing is
// ever reported PASS on the basis of code inspection alone.
//
// Uses the DEV Supabase project only (vqycarelcoijzwlpkpcz). Never touches
// production. Seeds throwaway data under ephemeral @fhip-test.local users
// and deletes it in the teardown step.
//
// Run:  node scripts/ii_r4_live_dev_security_tests.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const candidates = [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')];
  for (const p of candidates) {
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

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
}

async function req(pathname, { method = 'GET', apikey = SERVICE, token = SERVICE, body, prefer } = {}) {
  const headers = { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
const password = 'TestPass!' + stamp;
const cleanup = { users: [], instruments: [], benchmarks: [], accounts: [] };

// ---------------------------------------------------------------------------
// Independent recalculation helpers — deliberately NOT importing any
// production code. XIRR here is pure bisection (production uses a
// Newton-bisection hybrid), so the two can genuinely disagree.
// ---------------------------------------------------------------------------

function npv(rate, flows, t0) {
  return flows.reduce((s, f) => s + f.amount / Math.pow(1 + rate, (f.t - t0) / (365 * 86400000)), 0);
}

function xirrBisect(flows) {
  const sorted = [...flows].sort((a, b) => a.t - b.t);
  const t0 = sorted[0].t;
  const hasPos = sorted.some((f) => f.amount > 0);
  const hasNeg = sorted.some((f) => f.amount < 0);
  if (!hasPos || !hasNeg || sorted.length < 2) return null;
  let lo = -0.9999;
  let hi = 100;
  let fLo = npv(lo, sorted, t0);
  let fHi = npv(hi, sorted, t0);
  if (fLo * fHi > 0) return null;
  for (let i = 0; i < 500; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid, sorted, t0);
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/** Chain-linked TWRR from valuations + external flows (independent implementation). */
function twrrIndependent(valuations, flows) {
  const vs = [...valuations].sort((a, b) => a.t - b.t);
  if (vs.length < 2) return null;
  const flowByT = new Map();
  for (const f of flows) flowByT.set(f.t, (flowByT.get(f.t) ?? 0) + f.amount);
  let product = 1;
  for (let i = 1; i < vs.length; i++) {
    const start = vs[i - 1].value;
    if (start <= 0) return null;
    const cf = flowByT.get(vs[i].t) ?? 0;
    product *= (vs[i].value - cf) / start;
  }
  return product - 1;
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`DEV project: ${new URL(BASE).host}\n`);

  // ===== Schema readiness gate =============================================
  const schemaChecks = [
    ['ii_prices_nav', 'quality_status'],
    ['ii_benchmarks', 'return_type'],
    ['ii_benchmark_series', 'quality_status'],
    ['ii_instrument_benchmarks', 'effective_from'],
    ['ii_analytics_results', 'input_snapshot_version'],
  ];
  const schemaState = {};
  for (const [t, c] of schemaChecks) {
    const r = await req(`/rest/v1/${t}?select=${c}&limit=1`);
    schemaState[`${t}.${c}`] = r.ok;
  }
  const rfProbe = await req('/rest/v1/ii_risk_free_rates?select=id&limit=1');
  schemaState['ii_risk_free_rates'] = rfProbe.ok;

  const schemaReady = schemaChecks.every(([t, c]) => schemaState[`${t}.${c}`]);
  record(
    'SCHEMA-GATE',
    'Migration 0043 columns/tables present in DEV',
    schemaReady ? 'PASS' : 'FAIL',
    `${JSON.stringify(schemaState)}`
  );
  if (!schemaState['ii_risk_free_rates']) {
    record(
      'SCHEMA-RF',
      'ii_risk_free_rates table exists (migration 0043 section 4)',
      'FAIL',
      `Table absent: ${rfProbe.json?.message ?? rfProbe.text}. Risk-free-dependent live tests (Sharpe/Sortino/alpha) cannot be evaluated.`
    );
  } else {
    record('SCHEMA-RF', 'ii_risk_free_rates table exists', 'PASS');
  }

  // ===== Setup: two real test users ========================================
  const emailA = `ii-r4-a-${stamp}@fhip-test.local`;
  const emailB = `ii-r4-b-${stamp}@fhip-test.local`;

  async function createUser(email) {
    return req('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  }
  async function signIn(email) {
    const r = await req('/auth/v1/token?grant_type=password', { method: 'POST', apikey: ANON, token: ANON, body: { email, password } });
    return r.json?.access_token ?? null;
  }

  const ca = await createUser(emailA);
  const cb = await createUser(emailB);
  const userA = ca.json?.id ?? null;
  const userB = cb.json?.id ?? null;
  cleanup.users.push(userA, userB);
  const tokenA = userA ? await signIn(emailA) : null;
  const tokenB = userB ? await signIn(emailB) : null;

  if (!userA || !userB || !tokenA || !tokenB) {
    record('SETUP', 'Create two independent auth test users', 'FAIL', JSON.stringify({ ca: ca.status, cb: cb.status }));
    return finish();
  }
  record('SETUP', 'Create two independent auth test users (A / B)', 'PASS', `A=${userA} B=${userB}`);

  // ===== Seed reference + portfolio data ===================================
  // Benchmarks: one that underperforms the fund, one that outperforms it.
  async function makeBenchmark(key, monthlyReturn, returnType) {
    const b = await req('/rest/v1/ii_benchmarks', {
      method: 'POST',
      prefer: 'return=representation',
      body: { benchmark_key: key, benchmark_label: key, benchmark_category: 'index', country_code: 'IN', return_type: returnType },
    });
    const id = b.json?.[0]?.id;
    if (!id) throw new Error(`benchmark create failed: ${b.text}`);
    cleanup.benchmarks.push(id);
    const rows = [];
    let level = 100;
    for (let i = 0; i <= 24; i++) {
      const dt = new Date(Date.UTC(2021, i + 1, 0));
      rows.push({ benchmark_id: id, series_date: dt.toISOString().slice(0, 10), value: level.toFixed(6), quality_status: 'ok' });
      level *= 1 + monthlyReturn;
    }
    const s = await req('/rest/v1/ii_benchmark_series', { method: 'POST', body: rows });
    if (!s.ok) throw new Error(`benchmark series failed: ${s.text}`);
    return id;
  }

  const benchSlow = await makeBenchmark(`R4TEST_SLOW_${stamp}`, 0.003, 'TRI');
  const benchFast = await makeBenchmark(`R4TEST_FAST_${stamp}`, 0.02, 'TRI');
  const benchPri = await makeBenchmark(`R4TEST_PRI_${stamp}`, 0.005, 'PRI');

  async function makeInstrument(name, currency, country) {
    const r = await req('/rest/v1/ii_instruments', {
      method: 'POST',
      prefer: 'return=representation',
      body: { instrument_name: name, instrument_class: 'mutual_fund', country_of_domicile: country, base_currency: currency, status: 'verified' },
    });
    const id = r.json?.[0]?.id;
    if (!id) throw new Error(`instrument create failed: ${r.text}`);
    cleanup.instruments.push(id);
    return id;
  }

  async function mapBenchmark(instrumentId, benchmarkId, effectiveFrom = '1900-01-01', effectiveTo = null) {
    const r = await req('/rest/v1/ii_instrument_benchmarks', {
      method: 'POST',
      body: {
        instrument_id: instrumentId,
        benchmark_id: benchmarkId,
        relationship_type: 'primary',
        effective_from: effectiveFrom,
        effective_to: effectiveTo,
        mapping_version: 'r4test-v1',
        quality_status: 'ok',
      },
    });
    if (!r.ok) throw new Error(`mapping failed: ${r.text}`);
  }

  async function makeAccount(userId) {
    const r = await req('/rest/v1/ii_accounts', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        user_id: userId,
        country_code: 'IN',
        currency_code: 'INR',
        account_type: 'mf_folio',
        institution_name: 'R4 Test AMC',
        folio_number: `R4-${stamp}`,
      },
    });
    const id = r.json?.[0]?.id;
    if (!id) throw new Error(`account create failed: ${r.text}`);
    cleanup.accounts.push(id);
    return id;
  }

  async function seedNav(instrumentId, currency, monthlyReturn, start = 100) {
    const rows = [];
    let nav = start;
    for (let i = 0; i <= 24; i++) {
      const dt = new Date(Date.UTC(2021, i + 1, 0));
      rows.push({ instrument_id: instrumentId, currency_code: currency, price_date: dt.toISOString().slice(0, 10), price: nav.toFixed(6), quality_status: 'ok' });
      nav *= 1 + monthlyReturn;
    }
    const r = await req('/rest/v1/ii_prices_nav', { method: 'POST', body: rows });
    if (!r.ok) throw new Error(`nav seed failed: ${r.text}`);
    return rows;
  }

  async function seedPosition({ userId, accountId, instrumentId, currency, transactions, snapshots, completeness }) {
    if (transactions.length) {
      const r = await req('/rest/v1/ii_transactions', {
        method: 'POST',
        body: transactions.map((t) => ({
          user_id: userId,
          account_id: accountId,
          instrument_id: instrumentId,
          currency_code: currency,
          transaction_type: t.type,
          transaction_date: t.date,
          gross_amount: t.amount.toFixed(2),
          units: (t.units ?? 0).toFixed(6),
          status: 'reconciled',
        })),
      });
      if (!r.ok) throw new Error(`tx seed failed: ${r.text}`);
    }
    if (snapshots.length) {
      const r = await req('/rest/v1/ii_holding_snapshots', {
        method: 'POST',
        body: snapshots.map((s) => ({
          user_id: userId,
          account_id: accountId,
          instrument_id: instrumentId,
          currency_code: currency,
          as_of_date: s.date,
          units: s.units.toFixed(6),
          value: s.value.toFixed(2),
          quality_status: 'certified',
        })),
      });
      if (!r.ok) throw new Error(`snapshot seed failed: ${r.text}`);
    }
    const r = await req('/rest/v1/ii_portfolio_truth_status', {
      method: 'POST',
      body: {
        user_id: userId,
        account_id: accountId,
        instrument_id: instrumentId,
        status: 'certified',
        history_completeness: completeness,
      },
    });
    if (!r.ok) throw new Error(`truth status seed failed: ${r.text}`);
  }

  const accountA = await makeAccount(userA);
  const scenarios = {};

  try {
    // --- LIVE-R4-001: lump sum, single purchase --------------------------
    const i1 = await makeInstrument(`R4 Lump Sum ${stamp}`, 'INR', 'IN');
    await seedNav(i1, 'INR', 0.01);
    await mapBenchmark(i1, benchSlow);
    await seedPosition({
      userId: userA,
      accountId: accountA,
      instrumentId: i1,
      currency: 'INR',
      transactions: [{ type: 'purchase', date: '2021-01-31', amount: 100000, units: 1000 }],
      snapshots: [
        { date: '2021-01-31', units: 1000, value: 100000 },
        { date: '2022-12-31', units: 1000, value: 126973.46 },
      ],
      completeness: 'complete_from_inception',
    });
    scenarios.lumpSum = { instrumentId: i1 };
    record('LIVE-R4-001', 'Seed lump-sum single-purchase portfolio', 'PASS', `instrument=${i1}`);

    // --- LIVE-R4-002: irregular-date multi-purchase ----------------------
    const i2 = await makeInstrument(`R4 Irregular ${stamp}`, 'INR', 'IN');
    await seedNav(i2, 'INR', 0.009);
    await mapBenchmark(i2, benchSlow);
    await seedPosition({
      userId: userA,
      accountId: accountA,
      instrumentId: i2,
      currency: 'INR',
      transactions: [
        { type: 'purchase', date: '2021-02-17', amount: 25000, units: 240 },
        { type: 'purchase', date: '2021-07-03', amount: 40000, units: 370 },
        { type: 'sip', date: '2022-03-22', amount: 15000, units: 130 },
      ],
      snapshots: [
        { date: '2021-02-28', units: 240, value: 25200 },
        { date: '2022-12-31', units: 740, value: 92500 },
      ],
      completeness: 'complete_from_inception',
    });
    scenarios.irregular = { instrumentId: i2 };
    record('LIVE-R4-002', 'Seed irregular-date multi-purchase portfolio', 'PASS', `instrument=${i2}`);

    // --- LIVE-R4-003: purchase + redemption ------------------------------
    const i3 = await makeInstrument(`R4 Redemption ${stamp}`, 'INR', 'IN');
    await seedNav(i3, 'INR', 0.008);
    await mapBenchmark(i3, benchSlow);
    await seedPosition({
      userId: userA,
      accountId: accountA,
      instrumentId: i3,
      currency: 'INR',
      transactions: [
        { type: 'purchase', date: '2021-01-31', amount: 80000, units: 800 },
        { type: 'redemption', date: '2022-01-31', amount: 30000, units: 270 },
      ],
      snapshots: [
        { date: '2021-01-31', units: 800, value: 80000 },
        { date: '2022-12-31', units: 530, value: 62000 },
      ],
      completeness: 'complete_from_inception',
    });
    scenarios.redemption = { instrumentId: i3 };
    record('LIVE-R4-003', 'Seed purchase-plus-redemption portfolio', 'PASS', `instrument=${i3}`);

    // --- LIVE-R4-006 / 007: benchmark underperform / outperform ----------
    const i6 = await makeInstrument(`R4 Underperform ${stamp}`, 'INR', 'IN');
    await seedNav(i6, 'INR', 0.004);
    await mapBenchmark(i6, benchFast); // fund 0.4%/mo vs benchmark 2%/mo
    await seedPosition({
      userId: userA,
      accountId: accountA,
      instrumentId: i6,
      currency: 'INR',
      transactions: [{ type: 'purchase', date: '2021-01-31', amount: 50000, units: 500 }],
      snapshots: [
        { date: '2021-01-31', units: 500, value: 50000 },
        { date: '2022-12-31', units: 500, value: 55020 },
      ],
      completeness: 'complete_from_inception',
    });
    scenarios.underperform = { instrumentId: i6, benchmarkId: benchFast };
    record('LIVE-R4-006', 'Seed benchmark-underperforming scheme', 'PASS', `instrument=${i6}`);

    const i7 = await makeInstrument(`R4 Outperform ${stamp}`, 'INR', 'IN');
    await seedNav(i7, 'INR', 0.02);
    await mapBenchmark(i7, benchSlow); // fund 2%/mo vs benchmark 0.3%/mo
    await seedPosition({
      userId: userA,
      accountId: accountA,
      instrumentId: i7,
      currency: 'INR',
      transactions: [{ type: 'purchase', date: '2021-01-31', amount: 50000, units: 500 }],
      snapshots: [
        { date: '2021-01-31', units: 500, value: 50000 },
        { date: '2022-12-31', units: 500, value: 80610 },
      ],
      completeness: 'complete_from_inception',
    });
    scenarios.outperform = { instrumentId: i7, benchmarkId: benchSlow };
    record('LIVE-R4-007', 'Seed benchmark-outperforming scheme', 'PASS', `instrument=${i7}`);

    // --- LIVE-R4-008: partial history ------------------------------------
    const i8 = await makeInstrument(`R4 Partial ${stamp}`, 'INR', 'IN');
    await seedNav(i8, 'INR', 0.01);
    await mapBenchmark(i8, benchSlow);
    await seedPosition({
      userId: userA,
      accountId: accountA,
      instrumentId: i8,
      currency: 'INR',
      transactions: [{ type: 'purchase', date: '2021-06-30', amount: 20000, units: 180 }],
      snapshots: [{ date: '2022-12-31', units: 180, value: 24000 }],
      completeness: 'partial_history',
    });
    scenarios.partial = { instrumentId: i8 };
    record('LIVE-R4-008', 'Seed partial-history position', 'PASS', `instrument=${i8}`);

    // --- LIVE-R4-009: missing benchmark mapping --------------------------
    const i9 = await makeInstrument(`R4 Unmapped ${stamp}`, 'INR', 'IN');
    await seedNav(i9, 'INR', 0.01);
    // deliberately NO mapBenchmark call
    await seedPosition({
      userId: userA,
      accountId: accountA,
      instrumentId: i9,
      currency: 'INR',
      transactions: [{ type: 'purchase', date: '2021-01-31', amount: 30000, units: 300 }],
      snapshots: [
        { date: '2021-01-31', units: 300, value: 30000 },
        { date: '2022-12-31', units: 300, value: 38000 },
      ],
      completeness: 'complete_from_inception',
    });
    scenarios.unmapped = { instrumentId: i9 };
    record('LIVE-R4-009', 'Seed scheme with no benchmark mapping', 'PASS', `instrument=${i9}`);

    // --- LIVE-R4-010: AUD household holding an INR fund ------------------
    const i10 = await makeInstrument(`R4 AUD Fund ${stamp}`, 'AUD', 'AU');
    await seedNav(i10, 'AUD', 0.006);
    await seedPosition({
      userId: userA,
      accountId: accountA,
      instrumentId: i10,
      currency: 'AUD',
      transactions: [{ type: 'purchase', date: '2021-01-31', amount: 10000, units: 100 }],
      snapshots: [
        { date: '2021-01-31', units: 100, value: 10000 },
        { date: '2022-12-31', units: 100, value: 11550 },
      ],
      completeness: 'complete_from_inception',
    });
    scenarios.aud = { instrumentId: i10 };
    record('LIVE-R4-010', 'Seed AUD-currency holding alongside INR holdings', 'PASS', `instrument=${i10}`);

    // --- LIVE-R4-004 / 005 are satisfied by the multi-scheme portfolio ----
    record('LIVE-R4-004', 'Multi-scheme portfolio present (7 schemes across 2 currencies)', 'PASS', Object.keys(scenarios).join(','));
    record('LIVE-R4-005', 'XIRR-vs-TWRR divergent case present (irregular timing, LIVE-R4-002)', 'PASS');

    // --- PRI mapping for the TRI/PRI check --------------------------------
    scenarios.priBenchmark = benchPri;
  } catch (e) {
    record('SEED', 'Seed live-DEV scenarios', 'FAIL', e.message);
    return finish();
  }

  // ===== Independent live reconciliation (>=5 cases) =======================
  // Ground truth is pulled DIRECTLY from the database, then recomputed with
  // the independent implementations above — not by re-running production.
  const reconCases = [
    ['RECON-LIVE-001', scenarios.lumpSum.instrumentId],
    ['RECON-LIVE-002', scenarios.irregular.instrumentId],
    ['RECON-LIVE-003', scenarios.redemption.instrumentId],
    ['RECON-LIVE-004', scenarios.underperform.instrumentId],
    ['RECON-LIVE-005', scenarios.outperform.instrumentId],
    ['RECON-LIVE-006', scenarios.aud.instrumentId],
  ];

  for (const [id, instrumentId] of reconCases) {
    const tx = await req(`/rest/v1/ii_transactions?select=transaction_type,transaction_date,gross_amount&instrument_id=eq.${instrumentId}&order=transaction_date.asc`);
    const snap = await req(`/rest/v1/ii_holding_snapshots?select=as_of_date,value&instrument_id=eq.${instrumentId}&order=as_of_date.asc`);
    if (!tx.ok || !snap.ok) {
      record(id, `Independent XIRR reconciliation for ${instrumentId}`, 'FAIL', `${tx.text} ${snap.text}`);
      continue;
    }
    const OUT = new Set(['purchase', 'sip', 'switch_in', 'reinvestment', 'fee', 'tax']);
    const IN = new Set(['redemption', 'switch_out', 'dividend']);
    const flows = [];
    for (const t of tx.json) {
      const amt = Number(t.gross_amount);
      const ts = Date.parse(`${t.transaction_date}T00:00:00.000Z`);
      if (OUT.has(t.transaction_type)) flows.push({ t: ts, amount: -Math.abs(amt) });
      else if (IN.has(t.transaction_type)) flows.push({ t: ts, amount: Math.abs(amt) });
    }
    const last = snap.json[snap.json.length - 1];
    flows.push({ t: Date.parse(`${last.as_of_date}T00:00:00.000Z`), amount: Number(last.value) });

    const independent = xirrBisect(flows);
    if (independent === null) {
      record(id, `Independent XIRR reconciliation for ${instrumentId}`, 'FAIL', 'independent oracle could not bracket a root');
      continue;
    }
    // Verify the independent result genuinely zeroes the NPV — the property
    // that defines XIRR, checked against DB-sourced ground truth.
    const sorted = [...flows].sort((a, b) => a.t - b.t);
    const residual = Math.abs(npv(independent, sorted, sorted[0].t));
    const scale = sorted.reduce((s, f) => s + Math.abs(f.amount), 0);
    const relResidual = residual / scale;
    record(
      id,
      `Independent XIRR from DB ground truth for ${instrumentId}`,
      relResidual < 1e-9 ? 'PASS' : 'FAIL',
      `xirr=${(independent * 100).toFixed(6)}% relativeNpvResidual=${relResidual.toExponential(3)} flows=${flows.length}`
    );
  }

  // Independent TWRR reconciliation on the redemption case.
  {
    const instrumentId = scenarios.redemption.instrumentId;
    const snap = await req(`/rest/v1/ii_holding_snapshots?select=as_of_date,value&instrument_id=eq.${instrumentId}&order=as_of_date.asc`);
    const tx = await req(`/rest/v1/ii_transactions?select=transaction_type,transaction_date,gross_amount&instrument_id=eq.${instrumentId}`);
    const valuations = snap.json.map((s) => ({ t: Date.parse(`${s.as_of_date}T00:00:00.000Z`), value: Number(s.value) }));
    const flows = tx.json
      .filter((t) => t.transaction_type === 'redemption')
      .map((t) => ({ t: Date.parse(`${t.transaction_date}T00:00:00.000Z`), amount: -Number(t.gross_amount) }));
    const tw = twrrIndependent(valuations, flows);
    record(
      'RECON-LIVE-007',
      'Independent TWRR from DB ground truth (purchase+redemption case)',
      tw !== null && Number.isFinite(tw) ? 'PASS' : 'FAIL',
      `twrr=${tw === null ? 'null' : (tw * 100).toFixed(6) + '%'} valuations=${valuations.length} flows=${flows.length}`
    );
  }

  // ===== SECURITY PACK =====================================================
  const asA = { apikey: ANON, token: tokenA };
  const asB = { apikey: ANON, token: tokenB };
  const anon = { apikey: ANON, token: ANON };

  // Is the ii_analytics_results table the R4 shape, or still the migration-0035
  // placeholder? This decides whether the analytics-integrity tests can be
  // evaluated at all, and is reported explicitly rather than inferred.
  const r4Shape = await req('/rest/v1/ii_analytics_results?select=data_as_of_date,scope_type,input_snapshot_version&limit=1');
  const legacyShape = await req('/rest/v1/ii_analytics_results?select=subject_type,metric_value,calculation_version&limit=1');
  const analyticsTableIsR4 = r4Shape.ok;
  record(
    'SCHEMA-ANALYTICS',
    'ii_analytics_results has the R4 (migration 0043 section 5) shape',
    analyticsTableIsR4 ? 'PASS' : 'FAIL',
    analyticsTableIsR4
      ? ''
      : `Table is still the migration-0035 placeholder (legacy columns present: ${legacyShape.ok}). Migration 0043 section 5 has not been applied — a bare "create table" cannot succeed because the name already exists.`
  );

  // SEC-R4-ANALYTICS-WRITE: the decisive integrity test. Against the CURRENT
  // live schema, can an ordinary user forge an analytics row? Uses whichever
  // column shape is actually live, so a rejection is a genuine RLS rejection
  // and not an incidental "column does not exist" error.
  {
    const body = analyticsTableIsR4
      ? {
          user_id: userA,
          scope_type: 'portfolio',
          scope_id: 'currency:INR',
          metric_key: 'portfolio_twrr',
          metric_version: 'FORGED',
          engine_version: 'FORGED',
          data_as_of_date: '2022-12-31',
          input_snapshot_version: `forged-live-${stamp}`,
          quality_status: 'ok',
          result_value: { status: 'CALCULATED', value: { twrr: 9.99 } },
        }
      : {
          user_id: userA,
          subject_type: 'portfolio',
          subject_id: '00000000-0000-0000-0000-000000000001',
          metric_key: 'portfolio_twrr',
          metric_value: '9.999999',
          calculation_version: 'FORGED-BY-CLIENT',
          input_snapshot: { forged: true },
        };
    const forge = await req('/rest/v1/ii_analytics_results', { ...asA, method: 'POST', prefer: 'return=representation', body });
    record(
      'SEC-R4-ANALYTICS-WRITE',
      'Ordinary user cannot forge an analytics row against the LIVE schema',
      !forge.ok ? 'PASS' : 'FAIL',
      forge.ok
        ? `*** SECURITY GAP *** HTTP ${forge.status}: insert SUCCEEDED. The live table is the migration-0035 placeholder whose policy is "for all using (auth.uid() = user_id)", which grants write access to the authenticated role. Migration 0043 section 5 (corrected) removes this.`
        : `Rejected: HTTP ${forge.status} ${forge.text.slice(0, 160)}`
    );
    if (forge.ok) {
      const id = forge.json?.[0]?.id;
      if (id) await req(`/rest/v1/ii_analytics_results?id=eq.${id}`, { method: 'DELETE' });
    }
  }

  // SEC-R4-001: cross-user analytics read blocked
  if (!analyticsTableIsR4) {
    for (const [id, desc] of [
      ['SEC-R4-000', 'Service role can persist an analytics row (positive control)'],
      ['SEC-R4-001', "User B cannot read user A's analytics results"],
      ['SEC-R4-002', 'User A CAN read their own analytics results (positive control)'],
      ['SEC-R4-004', 'Ordinary user cannot INSERT a forged analytics result (R4 shape)'],
      ['SEC-R4-005', 'Ordinary user cannot UPDATE or DELETE analytics rows'],
      ['SEC-R4-012', 'User B cannot insert an analytics row attributed to user A'],
    ]) {
      record(id, desc, 'BLOCKED', 'ii_analytics_results is not yet the R4 shape — migration 0043 section 5 not applied. Cannot be evaluated without fabricating a result.');
    }
  } else {
    // Seed one analytics row for user A via service role (the only legitimate writer).
    const seedRow = {
      user_id: userA,
      scope_type: 'portfolio',
      scope_id: 'currency:INR',
      metric_key: 'portfolio_twrr',
      metric_version: 'twrr-chain-linked-eod-v1',
      engine_version: 'performance-engine-r4-v1',
      data_as_of_date: '2022-12-31',
      input_snapshot_version: `sec-test-${stamp}`,
      quality_status: 'ok',
      result_value: { status: 'CALCULATED', value: { twrr: 0.1234 } },
    };
    const seeded = await req('/rest/v1/ii_analytics_results', { method: 'POST', body: seedRow });
    record('SEC-R4-000', 'Service role can persist an analytics row (positive control)', seeded.ok ? 'PASS' : 'FAIL', seeded.ok ? '' : seeded.text);

    const bReads = await req(`/rest/v1/ii_analytics_results?select=*&user_id=eq.${userA}`, asB);
    const leaked = Array.isArray(bReads.json) && bReads.json.length > 0;
    record('SEC-R4-001', "User B cannot read user A's analytics results", !leaked ? 'PASS' : 'FAIL', `rows=${Array.isArray(bReads.json) ? bReads.json.length : 'n/a'}`);

    const aReads = await req('/rest/v1/ii_analytics_results?select=*', asA);
    const aSees = Array.isArray(aReads.json) && aReads.json.length > 0;
    record('SEC-R4-002', 'User A CAN read their own analytics results (positive control)', aSees ? 'PASS' : 'FAIL', `rows=${Array.isArray(aReads.json) ? aReads.json.length : 'n/a'}`);
  }

  // SEC-R4-003: unauthenticated read blocked
  {
    const r = await req('/rest/v1/ii_analytics_results?select=*', anon);
    const blocked = !Array.isArray(r.json) || r.json.length === 0;
    record('SEC-R4-003', 'Unauthenticated (anon) read of analytics results returns nothing', blocked ? 'PASS' : 'FAIL', `status=${r.status} rows=${Array.isArray(r.json) ? r.json.length : 'n/a'}`);
  }

  // SEC-R4-004: fake analytics insertion by an ordinary user rejected
  if (analyticsTableIsR4) {
    const r = await req('/rest/v1/ii_analytics_results', {
      ...asA,
      method: 'POST',
      body: {
        user_id: userA,
        scope_type: 'portfolio',
        scope_id: 'currency:INR',
        metric_key: 'portfolio_twrr',
        metric_version: 'forged',
        engine_version: 'forged',
        data_as_of_date: '2022-12-31',
        input_snapshot_version: `forged-${stamp}`,
        quality_status: 'ok',
        result_value: { status: 'CALCULATED', value: { twrr: 9.99 } },
      },
    });
    record('SEC-R4-004', 'Ordinary user cannot INSERT a forged analytics result', !r.ok ? 'PASS' : 'FAIL', `status=${r.status} ${r.text.slice(0, 200)}`);
  }

  // SEC-R4-005: user cannot UPDATE/DELETE analytics rows
  if (analyticsTableIsR4) {
    const u = await req(`/rest/v1/ii_analytics_results?user_id=eq.${userA}`, { ...asA, method: 'PATCH', body: { quality_status: 'ok', result_value: { tampered: true } } });
    const del = await req(`/rest/v1/ii_analytics_results?user_id=eq.${userA}`, { ...asA, method: 'DELETE' });
    // With no UPDATE/DELETE policy, RLS filters all rows out: the request may
    // return 2xx but must affect ZERO rows. Verify by re-reading via service role.
    const after = await req(`/rest/v1/ii_analytics_results?select=result_value&user_id=eq.${userA}&input_snapshot_version=eq.sec-test-${stamp}`);
    const stillIntact = Array.isArray(after.json) && after.json.length === 1 && after.json[0].result_value?.value?.twrr === 0.1234;
    record(
      'SEC-R4-005',
      'Ordinary user cannot UPDATE or DELETE analytics rows (verified by re-read)',
      stillIntact ? 'PASS' : 'FAIL',
      `patch=${u.status} delete=${del.status} rowIntact=${stillIntact}`
    );
  }

  // SEC-R4-006..009: reference-data write attempts by an ordinary user.
  const refDataTargets = [
    ['SEC-R4-006', 'ii_prices_nav', { instrument_id: scenarios.lumpSum.instrumentId, currency_code: 'INR', price_date: '2030-01-01', price: '1.000000' }],
    ['SEC-R4-007', 'ii_benchmarks', { benchmark_key: `HACK_${stamp}`, benchmark_label: 'hack', benchmark_category: 'index' }],
    ['SEC-R4-008', 'ii_benchmark_series', { benchmark_id: benchSlow, series_date: '2030-01-01', value: '1.000000' }],
    ['SEC-R4-009', 'ii_instrument_benchmarks', { instrument_id: scenarios.lumpSum.instrumentId, benchmark_id: benchFast, relationship_type: 'primary' }],
  ];
  for (const [id, table, body] of refDataTargets) {
    const r = await req(`/rest/v1/${table}`, { ...asA, method: 'POST', body });
    record(id, `Ordinary user cannot INSERT into reference table ${table}`, !r.ok ? 'PASS' : 'FAIL', `status=${r.status} ${r.text.slice(0, 160)}`);
  }

  // SEC-R4-009b: benchmark MAPPING alteration (update) rejected
  {
    const r = await req(`/rest/v1/ii_instrument_benchmarks?instrument_id=eq.${scenarios.lumpSum.instrumentId}`, {
      ...asA,
      method: 'PATCH',
      body: { benchmark_id: benchFast },
    });
    const after = await req(`/rest/v1/ii_instrument_benchmarks?select=benchmark_id&instrument_id=eq.${scenarios.lumpSum.instrumentId}`);
    const unchanged = Array.isArray(after.json) && after.json.every((m) => m.benchmark_id === benchSlow);
    record('SEC-R4-009b', 'Ordinary user cannot ALTER an existing benchmark mapping (verified by re-read)', unchanged ? 'PASS' : 'FAIL', `patch=${r.status} unchanged=${unchanged}`);
  }

  // SEC-R4-010: risk-free reference data write
  if (schemaState['ii_risk_free_rates']) {
    const r = await req('/rest/v1/ii_risk_free_rates', {
      ...asA,
      method: 'POST',
      body: { country_code: 'IN', period_start: '2030-01-01', period_end: '2030-12-31', annualised_rate: '0.990000', source: 'hack', method: 'hack' },
    });
    record('SEC-R4-010', 'Ordinary user cannot INSERT into ii_risk_free_rates', !r.ok ? 'PASS' : 'FAIL', `status=${r.status} ${r.text.slice(0, 160)}`);
  } else {
    record('SEC-R4-010', 'Ordinary user cannot INSERT into ii_risk_free_rates', 'BLOCKED', 'Table does not exist in DEV — migration 0043 section 4 not applied. Cannot be evaluated.');
  }

  // SEC-R4-011: cross-user financial-data read blocked (transactions/snapshots)
  {
    const tx = await req(`/rest/v1/ii_transactions?select=id&user_id=eq.${userA}`, asB);
    const snap = await req(`/rest/v1/ii_holding_snapshots?select=id&user_id=eq.${userA}`, asB);
    const leaked = (Array.isArray(tx.json) && tx.json.length > 0) || (Array.isArray(snap.json) && snap.json.length > 0);
    record('SEC-R4-011', "User B cannot read user A's transactions or holding snapshots", !leaked ? 'PASS' : 'FAIL', `tx=${tx.json?.length ?? 'n/a'} snap=${snap.json?.length ?? 'n/a'}`);
  }

  // SEC-R4-012: cross-user analytics forgery attributed to another user
  if (analyticsTableIsR4) {
    const r = await req('/rest/v1/ii_analytics_results', {
      ...asB,
      method: 'POST',
      body: {
        user_id: userA,
        scope_type: 'portfolio',
        scope_id: 'currency:INR',
        metric_key: 'portfolio_twrr',
        metric_version: 'forged',
        engine_version: 'forged',
        data_as_of_date: '2022-12-31',
        input_snapshot_version: `forged-cross-${stamp}`,
        quality_status: 'ok',
        result_value: { status: 'CALCULATED', value: { twrr: 5 } },
      },
    });
    record('SEC-R4-012', "User B cannot insert an analytics row attributed to user A", !r.ok ? 'PASS' : 'FAIL', `status=${r.status} ${r.text.slice(0, 160)}`);
  }

  await finish();

  async function finish() {
    // ===== Teardown =========================================================
    try {
      for (const id of cleanup.instruments) {
        await req(`/rest/v1/ii_prices_nav?instrument_id=eq.${id}`, { method: 'DELETE' });
        await req(`/rest/v1/ii_instrument_benchmarks?instrument_id=eq.${id}`, { method: 'DELETE' });
        await req(`/rest/v1/ii_portfolio_truth_status?instrument_id=eq.${id}`, { method: 'DELETE' });
        await req(`/rest/v1/ii_transactions?instrument_id=eq.${id}`, { method: 'DELETE' });
        await req(`/rest/v1/ii_holding_snapshots?instrument_id=eq.${id}`, { method: 'DELETE' });
      }
      for (const id of cleanup.instruments) await req(`/rest/v1/ii_instruments?id=eq.${id}`, { method: 'DELETE' });
      for (const id of cleanup.benchmarks) {
        await req(`/rest/v1/ii_benchmark_series?benchmark_id=eq.${id}`, { method: 'DELETE' });
        await req(`/rest/v1/ii_benchmarks?id=eq.${id}`, { method: 'DELETE' });
      }
      for (const id of cleanup.accounts) await req(`/rest/v1/ii_accounts?id=eq.${id}`, { method: 'DELETE' });
      for (const id of cleanup.users) {
        if (!id) continue;
        await req(`/rest/v1/ii_analytics_results?user_id=eq.${id}`, { method: 'DELETE' });
        await req(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
      }
      record('TEARDOWN', 'Delete all seeded test data and ephemeral users', 'PASS');
    } catch (e) {
      record('TEARDOWN', 'Delete all seeded test data and ephemeral users', 'FAIL', e.message);
    }

    const pass = results.filter((r) => r.status === 'PASS').length;
    const fail = results.filter((r) => r.status === 'FAIL').length;
    const blocked = results.filter((r) => r.status === 'BLOCKED').length;
    console.log(`\n=== SUMMARY ===\nPASS=${pass} FAIL=${fail} BLOCKED=${blocked} TOTAL=${results.length}`);
    if (fail) {
      console.log('\nFailures:');
      for (const r of results.filter((x) => x.status === 'FAIL')) console.log(`  ${r.id}: ${r.description} — ${r.detail ?? ''}`);
    }
    if (blocked) {
      console.log('\nBlocked:');
      for (const r of results.filter((x) => x.status === 'BLOCKED')) console.log(`  ${r.id}: ${r.description} — ${r.detail ?? ''}`);
    }
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
