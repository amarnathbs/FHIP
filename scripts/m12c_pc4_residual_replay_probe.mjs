/**
 * M12C §8.3 / §8.4 — READ-ONLY source-order replay of the five PC4
 * reconciliation residuals.
 *
 * READ-ONLY. HTTP GET only. No POST/PATCH/DELETE/RPC/DDL/DML anywhere.
 *
 * PRIVACY: this reads the Product Owner's real `ii_transactions` rows. **No
 * scheme name, folio number, PAN, holder name, amount, NAV or source
 * description is ever printed.** Only: instrument id 8-char prefix, canonical
 * transaction TYPE, transaction DATE, and UNIT counts — the three fields the
 * reconciliation arithmetic is actually made of. Nothing printed here can
 * identify a person or an instrument.
 *
 * THE DECISIVE TEST. `reconcilePosition` sums the transaction stream from a
 * ZERO baseline whenever `history_completeness = 'complete_from_inception'`,
 * which production reports for all 17 positions. If a position's RUNNING
 * cumulative unit balance ever goes NEGATIVE in source order, the position
 * cannot have started from zero: units were redeemed that the reconstructed
 * stream never acquired. That is arithmetic proof of a missing opening
 * balance, independent of any hypothesis about why it is missing.
 *
 * Usage:  node scripts/m12c_pc4_residual_replay_probe.mjs [dev|prod]
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

// Mirrors lib/services/investment-intelligence/reconciliation.ts DIRECTION_TABLE
// exactly. Kept as a literal so a drift in either place is visible.
const DIRECTION = {
  purchase: 'inflow', sip: 'inflow', switch_in: 'inflow', stp_in: 'inflow', transfer_in: 'inflow',
  reinvestment: 'inflow', bonus: 'inflow',
  redemption: 'outflow', switch_out: 'outflow', stp_out: 'outflow', swp: 'outflow', transfer_out: 'outflow', sale: 'outflow',
  dividend: 'cash_only', fee: 'cash_only', tax: 'cash_only',
  transfer: 'passthrough', merger: 'passthrough', segregation: 'passthrough', adjustment: 'passthrough',
  reversal: 'passthrough', unclassified: 'passthrough', split: 'passthrough',
};

function delta(type, units) {
  if (units === null || units === undefined) return 0;
  const d = DIRECTION[type];
  if (d === 'cash_only') return 0;
  if (d === 'inflow') return Math.abs(units);
  if (d === 'outflow') return -Math.abs(units);
  return units;
}

const short = (id) => String(id).slice(0, 8);

console.log(`=== M12C §8.3/§8.4 — ${TARGET.toUpperCase()} residual source-order replay (READ-ONLY) ===\n`);

const neg = await get('ii_transactions?select=zz_no_such_column_m12c&limit=1');
console.log(`NEGATIVE CONTROL : ${neg.ok ? 'FAILED — returned rows' : `PASS (${neg.code})`}\n`);

const truth = await get(
  'ii_portfolio_truth_status?select=instrument_id,account_id,unit_variance,unit_variance_within_tolerance,reconciled_opening_units,reconciled_closing_units,statement_closing_units,history_completeness&limit=200',
);
if (!truth.ok) throw new Error(`truth probe failed: ${truth.code}`);

const rows = truth.data;
console.log(`positions: ${rows.length}\n`);
console.log('inst      var          txns  types(distinct)                     minRunning   endRunning  impliedOpening  explains?');

const summary = [];
for (const r of [...rows].sort((a, b) => Math.abs(Number(b.unit_variance ?? 0)) - Math.abs(Number(a.unit_variance ?? 0)))) {
  const q = `ii_transactions?select=transaction_type,transaction_date,units,id&instrument_id=eq.${r.instrument_id}&account_id=eq.${r.account_id}&order=transaction_date.asc,id.asc&limit=2000`;
  const t = await get(q);
  if (!t.ok) {
    console.log(`${short(r.instrument_id)}  probe failed ${t.code}`);
    continue;
  }
  const txns = t.data;
  let running = 0;
  let minRunning = 0;
  const types = new Set();
  for (const x of txns) {
    types.add(x.transaction_type);
    running += delta(x.transaction_type, x.units === null ? null : Number(x.units));
    if (running < minRunning) minRunning = running;
  }
  const variance = Number(r.unit_variance ?? 0);
  // What single opening balance, applied at the start, would close this
  // position's variance exactly?
  const impliedOpening = -variance;
  const explains = Math.abs(impliedOpening - Math.abs(minRunning)) < 1e-6 && minRunning < 0;
  summary.push({ inst: short(r.instrument_id), variance, txns: txns.length, minRunning, endRunning: running, impliedOpening, negativeRunning: minRunning < 0, explains });
  console.log(
    `${short(r.instrument_id)}  ${String(variance).padEnd(12)} ${String(txns.length).padStart(4)}  ${[...types].join(',').padEnd(34).slice(0, 34)}  ${String(minRunning.toFixed(3)).padStart(11)}  ${String(running.toFixed(3)).padStart(10)}  ${String(impliedOpening.toFixed(3)).padStart(14)}  ${explains ? 'EXACT' : minRunning < 0 ? 'partial' : 'no'}`,
  );
}

console.log('\n--- summary ---');
const offenders = summary.filter((s) => s.variance !== 0);
console.log(`positions with non-zero variance            : ${offenders.length}`);
console.log(`  of those, running balance goes NEGATIVE   : ${offenders.filter((s) => s.negativeRunning).length}`);
console.log(`  of those, |minRunning| EXACTLY = -variance: ${offenders.filter((s) => s.explains).length}`);
const clean = summary.filter((s) => s.variance === 0);
console.log(`positions at variance 0.000                 : ${clean.length}`);
console.log(`  of those, running balance goes NEGATIVE   : ${clean.filter((s) => s.negativeRunning).length}  (must be 0 — the control)`);

console.log('\n=== end — zero writes performed ===');
