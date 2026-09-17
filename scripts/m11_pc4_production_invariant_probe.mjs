/**
 * M11 — Part Z.2 fresh re-verification of PC4's PRODUCTION reconciliation state.
 *
 * READ-ONLY. GET only. No POST, no RPC, no DDL, no DML. Nothing is created.
 *
 * Re-establishes, without inheriting M1's numbers, whether:
 *   - the five named reconciliation residuals still reproduce EXACTLY;
 *   - `unit_variance_within_tolerance` still never leaks `null` as `true`
 *     (PC4-INV-15 fail-closed reconciliation);
 *   - the 0-of-17 certification state M1 found still holds;
 *   - PC4's economic data has not moved since 2026-09-07.
 *
 * NO PAN, folio number, holder name, scheme name or raw statement text is
 * printed. Instrument ids are truncated to an 8-character prefix, exactly as
 * M1's own report did.
 */
import fs from 'node:fs';

const path = ['.env.local', 'D:/FHIP/.env.local'].find((p) => fs.existsSync(p));
const text = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
const env = {};
for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}

const BASE = env.PRODUCTION_SUPABASE_URL.replace(/\/$/, '');
const KEY = env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
if (BASE === (env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '')) {
  throw new Error('SAFETY: production url equals dev url');
}

async function get(q) {
  const res = await fetch(`${BASE}/rest/v1/${q}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    let b = null;
    try {
      b = await res.json();
    } catch {
      /* ignore */
    }
    return { ok: false, code: b?.code ?? res.status, message: b?.message ?? null };
  }
  return { ok: true, data: await res.json() };
}

console.log('=== M11 / Z.2 — PC4 PRODUCTION invariant re-verification (READ-ONLY) ===\n');

// Negative control first: the method must be able to report absence.
const neg = await get('ii_portfolio_truth_status?select=zz_no_such_column_m11&limit=1');
console.log(`NEGATIVE CONTROL  : ${neg.ok ? 'FAILED — returned rows for a nonexistent column' : `PASS (${neg.code})`}`);

const truth = await get('ii_portfolio_truth_status?select=instrument_id,status,certified_at,unit_variance,unit_variance_within_tolerance,history_completeness,blocking_reasons,warning_reasons&limit=200');
if (!truth.ok) throw new Error(`probe failed: ${truth.code} ${truth.message}`);
const rows = truth.data;

console.log(`\nii_portfolio_truth_status rows          : ${rows.length}`);

const statuses = {};
for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
console.log(`status breakdown                        : ${JSON.stringify(statuses)}`);
console.log(`certified_at non-null                   : ${rows.filter((r) => r.certified_at).length}`);

const tol = { true: 0, false: 0, null: 0 };
for (const r of rows) tol[String(r.unit_variance_within_tolerance)] = (tol[String(r.unit_variance_within_tolerance)] ?? 0) + 1;
console.log(`unit_variance_within_tolerance          : ${JSON.stringify(tol)}`);

const hist = {};
for (const r of rows) hist[r.history_completeness] = (hist[r.history_completeness] ?? 0) + 1;
console.log(`history_completeness                    : ${JSON.stringify(hist)}`);

const blockers = {};
for (const r of rows) for (const b of r.blocking_reasons ?? []) blockers[typeof b === 'string' ? b : b?.code] = (blockers[typeof b === 'string' ? b : b?.code] ?? 0) + 1;
console.log(`blocking_reasons (aggregated)           : ${JSON.stringify(blockers)}`);

const warnCount = rows.reduce((n, r) => n + (r.warning_reasons?.length ?? 0), 0);
console.log(`warning_reasons total                   : ${warnCount}`);

console.log('\n--- the five named residuals (M1 §3.1), compared to M1\'s recorded values ---');
const M1 = { '45773ec3': -156.618, '9a923d57': 111.505, '948fb23a': -12.932, '385feb70': -4.457, '76c30cb9': -2.678 };
const outOfTolerance = rows.filter((r) => r.unit_variance_within_tolerance === false);
let exact = 0;
for (const r of outOfTolerance) {
  const p = String(r.instrument_id).slice(0, 8);
  const now = Number(r.unit_variance);
  const then = M1[p];
  const match = then !== undefined && Math.abs(now - then) < 1e-9;
  if (match) exact += 1;
  console.log(`  ${p}  now=${now}  M1=${then ?? 'NOT IN M1 LIST'}  ${match ? 'EXACT MATCH' : 'DIFFERS / NEW'}`);
}
console.log(`  residuals out of tolerance now: ${outOfTolerance.length}   exact matches to M1: ${exact}/5`);

for (const [table, label] of [
  ['ii_transactions', 'ii_transactions'],
  ['ii_transaction_source_links', 'ii_transaction_source_links'],
  ['ii_holding_snapshots', 'ii_holding_snapshots'],
  ['ii_reconciliation_cases', 'ii_reconciliation_cases'],
  ['ii_document_parse_runs', 'ii_document_parse_runs'],
]) {
  const res = await fetch(`${BASE}/rest/v1/${table}?select=id&limit=1`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  console.log(`${label.padEnd(40)}: count=${res.headers.get('content-range') ?? 'n/a'}`);
}

const latestTxn = await get('ii_transactions?select=created_at&order=created_at.desc&limit=1');
console.log(`\nmost recent ii_transactions.created_at   : ${latestTxn.ok ? latestTxn.data[0]?.created_at : latestTxn.code}`);
const latestEval = await get('ii_portfolio_truth_status?select=last_evaluated_at&order=last_evaluated_at.desc&limit=1');
console.log(`most recent last_evaluated_at           : ${latestEval.ok ? latestEval.data[0]?.last_evaluated_at : latestEval.code}`);

// Z.4 — production residue from THIS mission. Every table this mission's code
// would write to, counted on production.
console.log('\n--- Z.4: this mission\'s own production residue ---');
for (const t of [
  'aie_document_intake',
  'aie_extraction_run',
  'aie_unresolved_item',
  'aie_review_decision',
  'aie_field_candidate',
  'aie_reconciliation_run',
  'aie_mask_token_map',
  'aie_ai_cost_ledger',
  'ii_fund_holdings_snapshots',
  'ii_fund_holdings_lines',
]) {
  const res = await fetch(`${BASE}/rest/v1/${t}?select=*&limit=1`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  console.log(`  ${t.padEnd(30)}: ${res.ok || res.status === 206 ? (res.headers.get('content-range') ?? 'n/a') : `ERR ${res.status}`}`);
}

console.log('\nwrites performed: 0   rpcs called: 0   ddl: 0   rows created: 0');
