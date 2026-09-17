/**
 * M12C §8.4 — READ-ONLY attribution of each PC4 reconciliation residual to the
 * exact rows that produce it.
 *
 * READ-ONLY. HTTP GET only. No POST/PATCH/DELETE/RPC/DDL/DML anywhere.
 *
 * PRIVACY: prints ONLY instrument-id prefixes, canonical transaction TYPES,
 * transaction DATES and UNIT counts. No scheme name, folio number, PAN, holder
 * name, amount, NAV or source description is read into the output.
 *
 * Method: for every position, decompose the reconciled closing balance into
 * per-type signed unit contributions, then test a fixed list of candidate
 * explanations against the observed variance:
 *   H1  variance == -(sum of `reversal` deltas)      -> reversals double-applied
 *   H2  variance == -2 x (sum of `reversal` deltas)  -> reversal sign inverted
 *   H3  variance == -(sum of `unclassified` deltas)  -> unclassified mis-signed
 *   H4  variance == -(units of exactly one row)      -> one row wrongly included
 *   H5  variance == +(units of exactly one row)      -> one row wrongly dropped
 *   H6  variance == -(sum of a same-date row pair)   -> a duplicated pair
 * Every hypothesis is reported PASS/FAIL per position; a position that matches
 * none is reported as such rather than silently rounded into one that nearly
 * fits.
 *
 * Usage:  node scripts/m12c_pc4_residual_attribution_probe.mjs [dev|prod]
 */
import fs from 'node:fs';

const TARGET = (process.argv[2] ?? 'prod').toLowerCase();
const envPath = ['.env.local', 'D:/FHIP/.env.local'].find((p) => fs.existsSync(p));
if (!envPath) throw new Error('no .env.local found');
const text = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
const env = {};
for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}
const DEV_BASE = 'https://vqycarelcoijzwlpkpcz.supabase.co';
const PROD_BASE = (env.PRODUCTION_SUPABASE_URL ?? '').replace(/\/$/, '');
if (!PROD_BASE) throw new Error('PRODUCTION_SUPABASE_URL absent');
if (PROD_BASE === DEV_BASE) throw new Error('SAFETY: production url equals dev url');
const BASE = TARGET === 'dev' ? DEV_BASE : PROD_BASE;
const KEY = TARGET === 'dev' ? env.SUPABASE_SERVICE_ROLE_KEY : env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;

async function get(q) {
  const res = await fetch(`${BASE}/rest/v1/${q}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (!res.ok) {
    let b = null;
    try { b = await res.json(); } catch { /* ignore */ }
    return { ok: false, code: b?.code ?? res.status, message: b?.message ?? null };
  }
  return { ok: true, data: await res.json() };
}

const DIRECTION = {
  purchase: 'inflow', sip: 'inflow', switch_in: 'inflow', stp_in: 'inflow', transfer_in: 'inflow', reinvestment: 'inflow', bonus: 'inflow',
  redemption: 'outflow', switch_out: 'outflow', stp_out: 'outflow', swp: 'outflow', transfer_out: 'outflow', sale: 'outflow',
  dividend: 'cash_only', fee: 'cash_only', tax: 'cash_only',
  transfer: 'passthrough', merger: 'passthrough', segregation: 'passthrough', adjustment: 'passthrough', reversal: 'passthrough', unclassified: 'passthrough', split: 'passthrough',
};
const delta = (type, units) => {
  if (units === null || units === undefined) return 0;
  const d = DIRECTION[type];
  if (d === 'cash_only') return 0;
  if (d === 'inflow') return Math.abs(units);
  if (d === 'outflow') return -Math.abs(units);
  return units;
};
const eq = (a, b) => Math.abs(a - b) < 1e-6;
const short = (id) => String(id).slice(0, 8);

console.log(`=== M12C §8.4 — ${TARGET.toUpperCase()} residual attribution (READ-ONLY) ===\n`);
const neg = await get('ii_transactions?select=zz_no_such_column_m12c&limit=1');
console.log(`NEGATIVE CONTROL : ${neg.ok ? 'FAILED' : `PASS (${neg.code})`}\n`);

const truth = await get('ii_portfolio_truth_status?select=instrument_id,account_id,unit_variance,statement_closing_units,reconciled_closing_units&limit=200');
if (!truth.ok) throw new Error(`truth probe failed: ${truth.code}`);

for (const r of truth.data.filter((x) => Number(x.unit_variance) !== 0).sort((a, b) => Math.abs(Number(b.unit_variance)) - Math.abs(Number(a.unit_variance)))) {
  const variance = Number(r.unit_variance);
  const t = await get(`ii_transactions?select=id,transaction_type,transaction_date,units&instrument_id=eq.${r.instrument_id}&account_id=eq.${r.account_id}&order=transaction_date.asc,id.asc&limit=2000`);
  if (!t.ok) { console.log(`${short(r.instrument_id)}: probe failed ${t.code}`); continue; }
  const txns = t.data.map((x) => ({ ...x, u: x.units === null ? null : Number(x.units), d: delta(x.transaction_type, x.units === null ? null : Number(x.units)) }));

  console.log(`\n================ instrument ${short(r.instrument_id)}  variance ${variance} ================`);
  console.log(`rows ${txns.length}  reconciled ${r.reconciled_closing_units}  statement ${r.statement_closing_units}`);

  const byType = {};
  for (const x of txns) {
    byType[x.transaction_type] ??= { n: 0, sumDelta: 0, sumUnits: 0, nullUnits: 0 };
    byType[x.transaction_type].n += 1;
    byType[x.transaction_type].sumDelta += x.d;
    byType[x.transaction_type].sumUnits += x.u ?? 0;
    if (x.u === null) byType[x.transaction_type].nullUnits += 1;
  }
  console.log('  type            n   sum(signed delta)   sum(raw units)   null-units');
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(14)} ${String(v.n).padStart(3)}   ${v.sumDelta.toFixed(3).padStart(17)}   ${v.sumUnits.toFixed(3).padStart(14)}   ${v.nullUnits}`);
  }

  const revSum = byType.reversal?.sumDelta ?? 0;
  const uncSum = byType.unclassified?.sumDelta ?? 0;

  const h = [];
  h.push(['H1 reversals double-applied   ', eq(variance, -revSum) && revSum !== 0]);
  h.push(['H2 reversal sign inverted     ', eq(variance, -2 * revSum) && revSum !== 0]);
  h.push(['H3 unclassified mis-signed    ', eq(variance, -uncSum) && uncSum !== 0]);
  const single = txns.filter((x) => eq(x.d, -variance) || eq(x.d, variance));
  h.push([`H4/H5 exactly one row explains (${single.length} candidates)`, single.length > 0]);
  // same-date pairs
  let pairHit = 0;
  const byDate = {};
  for (const x of txns) (byDate[x.transaction_date] ??= []).push(x);
  for (const arr of Object.values(byDate)) {
    for (let i = 0; i < arr.length; i += 1) for (let j = i + 1; j < arr.length; j += 1) if (eq(arr[i].d + arr[j].d, -variance)) pairHit += 1;
  }
  h.push([`H6 a same-date row pair explains (${pairHit} pairs)`, pairHit > 0]);
  for (const [label, hit] of h) console.log(`  ${hit ? 'MATCH ' : '  no  '} ${label}`);

  if (single.length > 0 && single.length <= 6) {
    console.log('  single-row candidates (type / date / units):');
    for (const x of single) console.log(`    ${x.transaction_type.padEnd(14)} ${x.transaction_date}  units ${x.u}`);
  }
  if (byType.reversal) {
    console.log('  reversal rows (date / units / delta):');
    for (const x of txns.filter((y) => y.transaction_type === 'reversal')) console.log(`    ${x.transaction_date}  units ${x.u}  delta ${x.d}`);
  }
  if (byType.unclassified) {
    console.log('  unclassified rows (date / units / delta):');
    for (const x of txns.filter((y) => y.transaction_type === 'unclassified')) console.log(`    ${x.transaction_date}  units ${x.u}  delta ${x.d}`);
  }
}

console.log('\n=== end — zero writes performed ===');
