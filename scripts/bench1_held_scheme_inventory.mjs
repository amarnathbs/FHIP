#!/usr/bin/env node
// BENCH-1 Phase 2 -- PRIVACY-SAFE HELD-SCHEME INVENTORY (READ-ONLY).
//
// Usage:  node bench1_held_scheme_inventory.mjs dev|prod [outFile]
//
// READ-ONLY GUARANTEES
//  * The only network primitive is `get()` below, which issues HTTP GET against
//    <supabase-url>/rest/v1/<table>?... and nothing else (no POST/PATCH/DELETE/RPC).
//  * Credentials are read from D:\FHIP\.env.local inside this process and are
//    never printed, logged or written. Only the project ref (from the URL) is shown.
//  * Per-user rows (user_id, balances, units, amounts) are aggregated IN MEMORY and
//    only distinct scheme-level rows with counts/dates are emitted.
//
// REQUIRED-DATE RULE (reused from the existing code, not invented -- see INVENTORY_NOTES.md):
//   (A) tx rule  : first non-reversed / non-review_required transaction date of the scheme
//                  (analyticsRepository.ts earliest cash flow -> periodStart; holdingsRepository.ts
//                  earliestTxDateByPosition -> windowStart; R5 SIP first contribution).
//   (B) nav rule : earliest quality_status='ok' ii_prices_nav date on file for the instrument
//                  (analyticsOrchestrator.ts computeSchemeActive: start = navSeries[0].date).
//   benchmark series must have an observation ON OR BEFORE that date (valueOnOrBefore /
//   benchmarkWindowReturn have no start tolerance), so we pad by the EXISTING constant
//   MAX_BACKWARD_SEARCH_DAYS = 10 (sip/dateAlignment.ts) for weekend/holiday alignment.
import fs from 'node:fs';

const ENV = (process.argv[2] || '').toLowerCase();
if (!['dev', 'prod'].includes(ENV)) { console.error('usage: node bench1_held_scheme_inventory.mjs dev|prod [outFile]'); process.exit(2); }
const OUT = process.argv[3] || `inventory_${ENV}.json`;

const EXPECTED_REF = { dev: 'vqycarelcoijzwlpkpcz', prod: 'twwpnltizhtjxhamyoxt' };
const PAD_DAYS = 10; // MAX_BACKWARD_SEARCH_DAYS, lib/engines/investment-intelligence/sip/dateAlignment.ts:44

// ---- credentials (never printed) -----------------------------------------------------
function loadEnvFile(p) {
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const envVars = loadEnvFile('D:/FHIP/.env.local');
const URL_KEY = ENV === 'dev' ? 'NEXT_PUBLIC_SUPABASE_URL' : 'PRODUCTION_SUPABASE_URL';
const SECRET_KEY = ENV === 'dev' ? 'SUPABASE_SERVICE_ROLE_KEY' : 'PRODUCTION_SUPABASE_SERVICE_ROLE_KEY';
const BASE = (envVars[URL_KEY] || '').replace(/\/+$/, '');
const SECRET = envVars[SECRET_KEY] || '';
if (!BASE || !SECRET) { console.error(`missing ${URL_KEY} or ${SECRET_KEY} in .env.local`); process.exit(2); }
const REF = (BASE.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1];
if (REF !== EXPECTED_REF[ENV]) { console.error(`project ref mismatch for ${ENV}: got ${REF}, expected ${EXPECTED_REF[ENV]} -- aborting`); process.exit(2); }
console.log(`[${ENV}] project ref ${REF} (read-only GET only)`);

// ---- the ONLY network primitive: GET -----------------------------------------------
let requestCount = 0;
async function get(path, { range = null, count = false, retries = 4 } = {}) {
  const url = `${BASE}/rest/v1/${path}`;
  const headers = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, Accept: 'application/json' };
  if (range) headers.Range = `${range[0]}-${range[1]}`;
  if (count) headers.Prefer = `count=${count === 'estimated' ? 'estimated' : 'exact'}`;
  let lastErr;
  for (let a = 1; a <= retries; a++) {
    try {
      requestCount++;
      const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(90_000) });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} on ${path.split('?')[0]}: ${text.slice(0, 200)}`);
        err.status = res.status; err.body = text;
        if (res.status >= 500 || res.status === 429) { lastErr = err; await sleep(1500 * a); continue; }
        throw err;
      }
      const data = text ? JSON.parse(text) : [];
      const cr = res.headers.get('content-range');
      return { data, total: cr && cr.includes('/') && !cr.endsWith('/*') ? Number(cr.split('/')[1]) : null };
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      lastErr = e; await sleep(1500 * a);
    }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

async function getAll(pathNoRange, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data } = await get(pathNoRange, { range: [from, from + pageSize - 1] });
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}
async function getIn(table, select, col, ids, extra = '', batch = 60) {
  const rows = [];
  for (let i = 0; i < ids.length; i += batch) {
    const slice = ids.slice(i, i + batch);
    const part = await getAll(`${table}?select=${select}&${col}=in.(${slice.join(',')})${extra}&order=${col}.asc`);
    rows.push(...part);
  }
  return rows;
}
async function tryGetAll(path, label, issues) {
  try { return await getAll(path); } catch (e) { issues.push(`${label}: ${e.message.slice(0, 160)}`); return null; }
}

const issues = []; // tables/columns that could not be read
const tablesRead = new Set();
const note = (t) => tablesRead.add(t);

// ---- 1. held set: the 7 user-scoped tables of pc6_user_held_instrument_ids() (0189) ---
// instrument_id -> aggregate (users as Set, dates). No per-user value leaves this block.
const held = new Map();
function agg(id) {
  let a = held.get(id);
  if (!a) {
    a = { users: new Set(), snapUsers: new Set(), txUsers: new Set(), currentUsers: new Set(), tables: new Set(),
      firstTx: null, firstTxAny: null, latestTx: null, firstSnap: null, latestSnap: null, txCount: 0, txCurrencies: new Set(), snapCurrencies: new Set() };
    held.set(id, a);
  }
  return a;
}
const minD = (a, b) => (a === null || (b !== null && b < a) ? b : a);
const maxD = (a, b) => (a === null || (b !== null && b > a) ? b : a);

// transactions
{
  const rows = await tryGetAll('ii_transactions?select=instrument_id,user_id,transaction_date,status,currency_code&order=id.asc', 'ii_transactions', issues);
  note('ii_transactions(instrument_id,user_id,transaction_date,status,currency_code)');
  for (const r of rows || []) {
    if (!r.instrument_id) continue;
    const a = agg(r.instrument_id);
    a.tables.add('ii_transactions'); a.users.add(r.user_id); a.txUsers.add(r.user_id); a.txCount++;
    if (r.currency_code) a.txCurrencies.add(r.currency_code);
    a.firstTxAny = minD(a.firstTxAny, r.transaction_date);
    if (r.status !== 'reversed' && r.status !== 'review_required') {
      a.firstTx = minD(a.firstTx, r.transaction_date);
      a.latestTx = maxD(a.latestTx, r.transaction_date);
    }
  }
}
// snapshots (units read ONLY to decide "currently held"; never emitted)
{
  const rows = await tryGetAll('ii_holding_snapshots?select=instrument_id,user_id,account_id,as_of_date,units,currency_code&order=id.asc', 'ii_holding_snapshots', issues);
  note('ii_holding_snapshots(instrument_id,user_id,account_id,as_of_date,units,currency_code)');
  const latestPerPosition = new Map(); // account:instrument -> {date, positive, user}
  for (const r of rows || []) {
    if (!r.instrument_id) continue;
    const a = agg(r.instrument_id);
    a.tables.add('ii_holding_snapshots'); a.users.add(r.user_id); a.snapUsers.add(r.user_id);
    if (r.currency_code) a.snapCurrencies.add(r.currency_code);
    a.firstSnap = minD(a.firstSnap, r.as_of_date); a.latestSnap = maxD(a.latestSnap, r.as_of_date);
    const k = `${r.account_id}:${r.instrument_id}`;
    const cur = latestPerPosition.get(k);
    if (!cur || r.as_of_date > cur.date) latestPerPosition.set(k, { date: r.as_of_date, positive: Number(r.units) > 0, user: r.user_id, inst: r.instrument_id });
  }
  for (const v of latestPerPosition.values()) if (v.positive) agg(v.inst).currentUsers.add(v.user);
}
// the other five user-scoped tables
for (const t of ['ii_portfolio_truth_status', 'ii_tax_lots', 'ii_sip_series', 'ii_capital_gains_computations', 'ii_fhip_publications']) {
  let rows = await tryGetAll(`${t}?select=instrument_id,user_id&order=id.asc`, t, issues);
  if (rows === null) rows = await tryGetAll(`${t}?select=instrument_id&order=id.asc`, `${t}(no user_id)`, issues);
  note(`${t}(instrument_id,user_id)`);
  for (const r of rows || []) {
    if (!r.instrument_id) continue;
    const a = agg(r.instrument_id);
    a.tables.add(t); if (r.user_id) a.users.add(r.user_id);
  }
}
const heldIds = [...held.keys()].sort();
console.log(`[${ENV}] distinct held instruments (7 user-scoped tables): ${heldIds.length}`);

// ---- 2. instrument master + identifiers + scheme master ------------------------------
const instRows = await getIn('ii_instruments',
  'id,instrument_name,instrument_class,country_of_domicile,base_currency,isin,status,merged_into_instrument_id,is_active,created_at', 'id', heldIds);
note('ii_instruments(id,instrument_name,instrument_class,country_of_domicile,base_currency,isin,status,merged_into_instrument_id,is_active,created_at)');
const instById = new Map(instRows.map((r) => [r.id, r]));

const identRows = await getIn('ii_instrument_identifiers', 'instrument_id,identifier_scheme,identifier_value,country_code,is_active,effective_to', 'instrument_id', heldIds);
note('ii_instrument_identifiers(instrument_id,identifier_scheme,identifier_value,country_code,is_active,effective_to)');
const identBy = new Map();
for (const r of identRows) { if (!identBy.has(r.instrument_id)) identBy.set(r.instrument_id, []); identBy.get(r.instrument_id).push(r); }

const smRows = await getIn('ii_scheme_master',
  'instrument_id,amfi_scheme_code,scheme_name,amc_name,isin_growth_or_payout,isin_reinvestment,plan_raw,plan_type,option_raw,option_type,scheme_structure,category_header_raw,category_group,sub_category,lifecycle_status,inception_date,country_code,currency_code,effective_from,effective_to', 'instrument_id', heldIds);
note('ii_scheme_master(instrument_id,amfi_scheme_code,scheme_name,amc_name,isin_*,plan_*,option_*,scheme_structure,category_header_raw,category_group,sub_category,lifecycle_status,inception_date,country_code,currency_code,effective_from,effective_to)');
const smBy = new Map(); // current row (effective_to null) else latest effective_from
for (const r of smRows) {
  const c = smBy.get(r.instrument_id);
  const better = !c || (r.effective_to === null && c.effective_to !== null) || (((r.effective_to === null) === (c.effective_to === null)) && r.effective_from > c.effective_from);
  if (better) smBy.set(r.instrument_id, r);
}
const smCount = new Map(); for (const r of smRows) smCount.set(r.instrument_id, (smCount.get(r.instrument_id) || 0) + 1);

// ---- 3. NAV start/end on file + history floor ----------------------------------------
const navInfo = new Map();
for (let i = 0; i < heldIds.length; i++) {
  const id = heldIds[i];
  const first = await get(`ii_prices_nav?select=price_date&instrument_id=eq.${id}&quality_status=eq.ok&order=price_date.asc&limit=1`);
  const last = await get(`ii_prices_nav?select=price_date&instrument_id=eq.${id}&quality_status=eq.ok&order=price_date.desc&limit=1`);
  const cnt = await get(`ii_prices_nav?select=price_date&instrument_id=eq.${id}&quality_status=eq.ok`, { range: [0, 0], count: true });
  navInfo.set(id, { first: first.data[0]?.price_date ?? null, last: last.data[0]?.price_date ?? null, rows: cnt.total });
  if ((i + 1) % 25 === 0) console.log(`[${ENV}] nav bounds ${i + 1}/${heldIds.length}`);
}
note('ii_prices_nav(instrument_id,price_date,quality_status) -- bounds + count only');
const floorRows = (await tryGetAll(`ii_nav_history_floors?select=instrument_id,floor_date&instrument_id=in.(${heldIds.slice(0, 200).join(',')})`, 'ii_nav_history_floors', issues)) || [];
let floors = floorRows;
if (heldIds.length > 200) { floors = []; try { floors = await getIn('ii_nav_history_floors', 'instrument_id,floor_date', 'instrument_id', heldIds); } catch (e) { issues.push(`ii_nav_history_floors: ${e.message.slice(0, 160)}`); } }
note('ii_nav_history_floors(instrument_id,floor_date)');
const floorBy = new Map(floors.map((r) => [r.instrument_id, r.floor_date]));

// ---- 4. benchmark mapping (effective-dated) + benchmark + series availability --------
let mapRows = [];
try {
  mapRows = await getIn('ii_instrument_benchmarks',
    'instrument_id,benchmark_id,relationship_type,effective_from,effective_to,mapping_version,quality_status,mapping_basis', 'instrument_id', heldIds);
} catch (e) { issues.push(`ii_instrument_benchmarks(full cols): ${e.message.slice(0, 200)}`);
  mapRows = await getIn('ii_instrument_benchmarks', 'instrument_id,benchmark_id,relationship_type', 'instrument_id', heldIds); }
note('ii_instrument_benchmarks(instrument_id,benchmark_id,relationship_type,effective_from,effective_to,mapping_version,quality_status,mapping_basis)');
const benchIds = [...new Set(mapRows.map((r) => r.benchmark_id))];
let benchRows = [];
if (benchIds.length) {
  try { benchRows = await getIn('ii_benchmarks', 'id,benchmark_key,benchmark_label,benchmark_category,return_type,country_code,currency_code,frequency,licence_status,lifecycle_status,effective_from,effective_to,is_active', 'id', benchIds); }
  catch (e) { issues.push(`ii_benchmarks(full cols): ${e.message.slice(0, 200)}`); benchRows = await getIn('ii_benchmarks', 'id,benchmark_key,benchmark_label,benchmark_category,return_type,is_active', 'id', benchIds); }
}
note('ii_benchmarks(id,benchmark_key,benchmark_label,benchmark_category,return_type,country_code,currency_code,frequency,licence_status,lifecycle_status,effective_from,effective_to,is_active)');
const benchById = new Map(benchRows.map((r) => [r.id, r]));
const seriesInfo = new Map();
for (const bid of benchIds) {
  const q = 'quality_status=eq.ok';
  const f = await get(`ii_benchmark_series?select=series_date&benchmark_id=eq.${bid}&${q}&order=series_date.asc&limit=1`);
  const l = await get(`ii_benchmark_series?select=series_date&benchmark_id=eq.${bid}&${q}&order=series_date.desc&limit=1`);
  const c = await get(`ii_benchmark_series?select=series_date&benchmark_id=eq.${bid}&${q}`, { range: [0, 0], count: true });
  seriesInfo.set(bid, { min: f.data[0]?.series_date ?? null, max: l.data[0]?.series_date ?? null, rows: c.total });
}
note('ii_benchmark_series(benchmark_id,series_date,quality_status) -- bounds + count only');
let categoryDefaults = [];
try { categoryDefaults = await getAll('ii_benchmark_category_defaults?select=country_code,category_header_raw,benchmark_id,effective_from,effective_to&order=id.asc'); }
catch (e) { issues.push(`ii_benchmark_category_defaults: ${e.message.slice(0, 160)}`); }
note('ii_benchmark_category_defaults(country_code,category_header_raw,benchmark_id,effective_from,effective_to) -- count only');
let benchmarkCatalogue = [];
try { benchmarkCatalogue = await getAll('ii_benchmarks?select=id,benchmark_key,licence_status,lifecycle_status&order=id.asc'); } catch (e) { issues.push(`ii_benchmarks(catalogue): ${e.message.slice(0, 120)}`); }

// table totals (count only, no rows)
const tableTotals = {};
for (const [t, mode] of [['ii_instruments', true], ['ii_scheme_master', true], ['ii_benchmarks', true], ['ii_benchmark_series', true], ['ii_instrument_benchmarks', true], ['ii_benchmark_category_defaults', true], ['ii_nav_history_floors', true], ['ii_prices_nav', 'estimated']]) {
  try { tableTotals[t] = (await get(`${t}?select=*&limit=1`, { range: [0, 0], count: mode })).total; } catch (e) { tableTotals[t] = `error:${e.message.slice(0, 80)}`; }
}
note('row counts only (Prefer: count) for ii_instruments, ii_scheme_master, ii_benchmarks, ii_benchmark_series, ii_instrument_benchmarks, ii_benchmark_category_defaults, ii_nav_history_floors, ii_prices_nav');

// ---- helpers ---------------------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
function addDays(iso, d) { const t = new Date(`${iso}T00:00:00.000Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
function normAmc(n) { return (n || '').toLowerCase().replace(/\bmutual\s*fund\b/g, '').replace(/\b(asset\s*management|amc|limited|ltd|private|pvt)\b/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim(); }
function baseSchemeName(n) {
  let s = (n || '').toLowerCase().replace(/&/g, ' and ');
  s = s.replace(/\([^)]*\)/g, ' ');                                           // (IDCW), (Direct)...
  s = s.replace(/\b(direct|regular)\s*(plan)?\b/g, ' ');
  s = s.replace(/\b(growth|idcw|dividend|payout|reinvestment|re-?investment|bonus|income\s+distribution\s+cum\s+capital\s+withdrawal)\b(\s*(option|plan))?/g, ' ');
  s = s.replace(/\b(option|plan|plan\s*-)\b/g, ' ');
  s = s.replace(/\b(daily|weekly|fortnightly|monthly|quarterly|half\s*yearly|annual|yearly)\s+(idcw|dividend)\b/g, ' ');
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}
function redactDigits(s) { return typeof s === 'string' ? s.replace(/\d{7,}/g, '[digits]') : s; }

// ---- 5. assemble rows ---------------------------------------------------------------
const rows = [];
const amfiCount = new Map(), isinCount = new Map();
for (const id of heldIds) {
  const inst = instById.get(id);
  const sm = smBy.get(id) || null;
  const idents = identBy.get(id) || [];
  const amfiIds = [...new Set(idents.filter((x) => x.identifier_scheme === 'amfi_scheme_code').map((x) => x.identifier_value))];
  const isinIds = [...new Set(idents.filter((x) => x.identifier_scheme === 'isin').map((x) => x.identifier_value))];
  const amfi = sm?.amfi_scheme_code || amfiIds[0] || null;
  const isins = [...new Set([inst?.isin, sm?.isin_growth_or_payout, sm?.isin_reinvestment, ...isinIds].filter(Boolean))].sort();
  const a = held.get(id);
  const notes = [];
  if (!inst) notes.push('instrument_row_missing');
  if (!sm) notes.push('no_scheme_master_row');
  if (amfiIds.length > 1) notes.push('multiple_amfi_codes');
  if (sm && amfiIds.length && !amfiIds.includes(sm.amfi_scheme_code)) notes.push('amfi_code_differs_between_master_and_identifiers');
  if (inst?.status === 'merged' || inst?.merged_into_instrument_id) notes.push('instrument_merged');
  if (inst && inst.status === 'provisional') notes.push('instrument_provisional');
  if (inst && inst.is_active === false) notes.push('instrument_inactive');
  if (inst && inst.instrument_class !== 'mutual_fund') notes.push(`non_mutual_fund_class:${inst.instrument_class}`);
  if (inst && inst.country_of_domicile !== 'IN') notes.push(`non_IN_domicile:${inst.country_of_domicile}`);
  if (inst && inst.base_currency !== 'INR') notes.push(`non_INR_base_currency:${inst.base_currency}`);
  const unresolved = !sm; // no scheme-master linkage
  const fixture = /^\s*R6F|^\s*TEST|test\s*delete\s*me/i.test(inst?.instrument_name || '') || /^TESTFIX-/i.test(amfi || '');
  if (fixture) notes.push('likely_test_fixture');
  if (unresolved && !amfi) notes.push('no_amfi_code_anywhere');

  const schemeName = sm?.scheme_name ?? inst?.instrument_name ?? null;
  const amcName = sm?.amc_name ?? null;
  const famKey = `${normAmc(amcName) || 'unknown_amc'}|${baseSchemeName(schemeName) || 'unknown_scheme'}`;

  // dates
  const nav = navInfo.get(id) || { first: null, last: null, rows: 0 };
  const firstTx = a.firstTx;
  const txBasis = firstTx ? 'first_transaction' : (a.firstSnap ? 'first_snapshot_fallback' : null);
  const txRuleFrom = firstTx || a.firstSnap || null;
  const txSeriesFrom = txRuleFrom ? addDays(txRuleFrom, -PAD_DAYS) : null;
  const navSeriesFrom = nav.first ? addDays(nav.first, -PAD_DAYS) : null;
  let requiredFrom = null, requiredBasis = null;
  if (txSeriesFrom && navSeriesFrom) { if (navSeriesFrom <= txSeriesFrom) { requiredFrom = navSeriesFrom; requiredBasis = 'earliest_nav_on_file'; } else { requiredFrom = txSeriesFrom; requiredBasis = txBasis; } }
  else if (txSeriesFrom) { requiredFrom = txSeriesFrom; requiredBasis = `${txBasis}(no_nav_on_file)`; }
  else if (navSeriesFrom) { requiredFrom = navSeriesFrom; requiredBasis = 'earliest_nav_on_file(no_tx_or_snapshot)'; }
  const latestHolding = a.latestSnap || a.latestTx || null;

  // mapping
  const maps = mapRows.filter((m) => m.instrument_id === id && m.relationship_type === 'primary');
  const usable = maps.filter((m) => (m.quality_status ?? 'ok') === 'ok');
  const eff = (m, d) => (m.effective_from ?? '1900-01-01') <= d && (!m.effective_to || m.effective_to >= d);
  const currentMaps = usable.filter((m) => eff(m, today));
  const cur = currentMaps.sort((x, y) => (y.effective_from ?? '').localeCompare(x.effective_from ?? ''))[0] || null;
  let mappingState;
  if (maps.length === 0) mappingState = 'unmapped';
  else if (cur) mappingState = 'mapped_current';
  else if (usable.length === 0) mappingState = maps.some((m) => m.quality_status === 'ambiguous') ? 'ambiguous_only' : 'superseded_only';
  else mappingState = 'mapped_not_effective_today';
  const bm = cur ? benchById.get(cur.benchmark_id) : null;
  const si = cur ? seriesInfo.get(cur.benchmark_id) : null;

  let availability;
  let coversTx = null, coversNav = null, coversToLatest = null;
  if (!cur) availability = 'no_current_mapping';
  else if (!bm) availability = 'benchmark_row_missing';
  else if (!si || !si.rows) availability = 'benchmark_has_no_series_rows';
  else {
    coversTx = txSeriesFrom ? si.min <= txSeriesFrom : null;
    coversNav = navSeriesFrom ? si.min <= navSeriesFrom : null;
    coversToLatest = latestHolding ? si.max >= addDays(latestHolding, -PAD_DAYS) : null;
    const need = requiredFrom;
    availability = need && si.min <= need && coversToLatest !== false ? 'series_covers_required_window'
      : need && si.min > need ? `series_starts_after_required_from(${si.min})`
      : coversToLatest === false ? 'series_ends_before_latest_holding' : 'series_present_requirement_unknown';
  }
  if (bm && ['licence_required', 'unknown'].includes(bm.licence_status)) availability += `;licence_status=${bm.licence_status}`;

  // eligibility flags (see notes): engines apply NO class/country/currency filter; scheme matrix scope = mutual_fund|etf
  const cls = inst?.instrument_class ?? null;
  rows.push({
    scheme_family_key: famKey,
    instrument_id: id,
    amfi_scheme_code: amfi,
    isins,
    amc_name: amcName,
    scheme_name: redactDigits(schemeName),
    instrument_name: redactDigits(inst?.instrument_name ?? null),
    plan_type: sm?.plan_type ?? null, plan_raw: sm?.plan_raw ?? null,
    option_type: sm?.option_type ?? null, option_raw: sm?.option_raw ?? null,
    scheme_structure: sm?.scheme_structure ?? null,
    category_header_raw: sm?.category_header_raw ?? null,
    category_group: sm?.category_group ?? null,
    sub_category: sm?.sub_category ?? null,
    scheme_lifecycle_status: sm?.lifecycle_status ?? null,
    scheme_inception_date: sm?.inception_date ?? null,
    instrument_class: cls,
    country_of_domicile: inst?.country_of_domicile ?? null,
    base_currency: inst?.base_currency ?? null,
    scheme_master_country: sm?.country_code ?? null,
    scheme_master_currency: sm?.currency_code ?? null,
    transaction_currencies: [...a.txCurrencies].sort(),
    instrument_status: inst?.status ?? null,
    merged_into_instrument_id: inst?.merged_into_instrument_id ?? null,
    unresolved_identity: unresolved,
    likely_test_fixture: fixture,
    identity_notes: notes,
    scheme_master_row_count: smCount.get(id) || 0,
    benchmark_comparison_engine_eligible: !!inst, // loadAnalyticsDataset applies no instrument_class/country filter
    matrix_scope_scheme: cls === 'mutual_fund' || cls === 'etf',
    holder_basis: 'distinct user_id (account owner; analytics loaders are scoped per user_id) across the 7 user-scoped ii_* tables of pc6_user_held_instrument_ids()',
    holder_count_ever: a.users.size,
    holder_count_with_snapshot: a.snapUsers.size,
    holder_count_with_transactions: a.txUsers.size,
    holder_count_current_positive_units: a.currentUsers.size,
    user_tables_referencing: [...a.tables].sort(),
    first_transaction_date: firstTx,
    first_transaction_date_any_status: a.firstTxAny,
    earliest_snapshot_date: a.firstSnap,
    latest_snapshot_date: a.latestSnap,
    latest_transaction_date: a.latestTx,
    latest_holding_date: latestHolding,
    earliest_nav_date_on_file: nav.first,
    latest_nav_date_on_file: nav.last,
    nav_rows_on_file: nav.rows,
    nav_history_floor_date: floorBy.get(id) ?? null,
    required_series_from_tx_rule: txSeriesFrom,
    required_series_from_nav_rule: navSeriesFrom,
    required_from_date: requiredFrom,
    required_basis: requiredBasis,
    alignment_pad_days: PAD_DAYS,
    mapping_state: mappingState,
    mapping_row_count_primary: maps.length,
    current_benchmark_key: bm?.benchmark_key ?? null,
    current_benchmark_label: bm?.benchmark_label ?? null,
    current_benchmark_return_type: bm?.return_type ?? null,
    current_benchmark_licence_status: bm?.licence_status ?? null,
    current_mapping_basis: cur?.mapping_basis ?? null,
    current_mapping_effective_from: cur?.effective_from ?? null,
    current_mapping_effective_to: cur?.effective_to ?? null,
    current_mapping_version: cur?.mapping_version ?? null,
    benchmark_series_rows: si?.rows ?? null,
    benchmark_series_min_date: si?.min ?? null,
    benchmark_series_max_date: si?.max ?? null,
    series_covers_tx_rule: coversTx,
    series_covers_nav_rule: coversNav,
    series_covers_to_latest_holding: coversToLatest,
    availability_state: availability,
  });
  if (amfi) amfiCount.set(amfi, (amfiCount.get(amfi) || 0) + 1);
  for (const i of isins) isinCount.set(i, (isinCount.get(i) || 0) + 1);
}
for (const r of rows) {
  if (r.amfi_scheme_code && amfiCount.get(r.amfi_scheme_code) > 1) r.identity_notes.push('amfi_code_on_multiple_instruments');
  if (r.isins.some((i) => isinCount.get(i) > 1)) r.identity_notes.push('isin_on_multiple_instruments');
}
// same family+plan+option on >1 instrument => possible duplicate (NOT merged, flagged only)
const variantKey = (r) => `${r.scheme_family_key}|${r.plan_type}|${r.option_type}`;
const vc = new Map(); for (const r of rows) vc.set(variantKey(r), (vc.get(variantKey(r)) || 0) + 1);
for (const r of rows) if (vc.get(variantKey(r)) > 1) r.identity_notes.push('same_family_plan_option_on_multiple_instruments');

rows.sort((x, y) => (x.scheme_family_key + x.plan_type + x.option_type + x.instrument_id).localeCompare(y.scheme_family_key + y.plan_type + y.option_type + y.instrument_id));

const result = {
  meta: {
    environment: ENV, project_ref: REF, generated_at: new Date().toISOString(), read_only: true, http_get_requests: requestCount,
    held_basis: 'union of instrument_id in ii_transactions, ii_holding_snapshots, ii_portfolio_truth_status, ii_tax_lots, ii_sip_series, ii_capital_gains_computations, ii_fhip_publications (migration 0189 definition; includes reversed txns and any statement status)',
    holder_count_unit: 'distinct user_id',
    required_date_rule: {
      tx_rule: 'first non-reversed/non-review_required transaction_date (fallback: earliest snapshot as_of_date)',
      nav_rule: 'earliest quality_status=ok ii_prices_nav price_date on file (analyticsOrchestrator.computeSchemeActive start = navSeries[0])',
      pad_days: PAD_DAYS, pad_source: 'MAX_BACKWARD_SEARCH_DAYS in sip/dateAlignment.ts (existing constant, reused)',
      required_from_date: 'min(tx_rule - pad, nav_rule - pad)',
    },
    tables_read: [...tablesRead].sort(),
    read_issues: issues,
    benchmark_catalogue_rows: benchmarkCatalogue.length,
    benchmark_catalogue_licence_status_counts: benchmarkCatalogue.reduce((m, b) => { m[b.licence_status ?? 'null'] = (m[b.licence_status ?? 'null'] || 0) + 1; return m; }, {}),
    benchmark_category_defaults_rows: categoryDefaults.length,
    table_totals: tableTotals,
    held_instruments: heldIds.length,
  },
  rows,
};
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(`[${ENV}] wrote ${OUT}: ${rows.length} held instrument rows, ${requestCount} GET requests, issues=${issues.length}`);
