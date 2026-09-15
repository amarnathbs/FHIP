/**
 * M11 — Final Integrated Certification (Part Z) read-only migration-state probe.
 *
 * WHAT THIS DOES: read-only PostgREST GETs against DEV and PRODUCTION to
 * re-establish, fresh, whether this mission's four migrations (0153, 0154,
 * 0155, 0157) are applied. Positive controls prove the method sees objects that
 * DO exist; negative controls prove it correctly reports absence rather than
 * returning false positives.
 *
 * WHAT THIS DOES NOT DO: no POST, no RPC, no DDL, no DML, on either database.
 * Nothing is created, so nothing needs cleaning up.
 *
 * 0154 is a CHECK-widening + trigger migration. Neither is visible to
 * PostgREST's schema cache, so it CANNOT be probed read-only. It is reported as
 * NOT PROBEABLE here rather than guessed; see the M11 report for how its state
 * is established.
 */
import fs from 'node:fs';

const ENV_CANDIDATES = ['.env.local', 'D:/FHIP/.env.local'];

function loadEnv() {
  const path = ENV_CANDIDATES.find((p) => fs.existsSync(p));
  if (!path) throw new Error('no .env.local found');
  // BOM + CRLF safe (M3-OPEN-3: the naive split('\n') + /(.*)$/ combination
  // yields ZERO keys against this file and produces an empty environment with
  // no error at all).
  const text = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { path, env: out, keyCount: Object.keys(out).length };
}

async function probe(baseUrl, key, pathAndQuery) {
  const url = `${baseUrl.replace(/\/$/, '')}/rest/v1/${pathAndQuery}`;
  try {
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (res.ok) return { ok: true, code: null, status: res.status };
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, code: body?.code ?? null, status: res.status, message: body?.message ?? null };
  } catch (err) {
    return { ok: false, code: 'NETWORK', status: 0, message: String(err?.message ?? err) };
  }
}

const TARGETS = [
  // --- negative controls: MUST report absent, or the method is worthless ---
  ['NEGCTL', 'nonexistent table', 'zz_no_such_table_m11?select=id&limit=1', 'ABSENT'],
  ['NEGCTL', 'nonexistent column', 'aie_document_intake?select=zz_no_such_column_m11&limit=1', 'ABSENT'],
  // --- positive controls: MUST report present ---
  ['POSCTL', '0140 aie_document_intake', 'aie_document_intake?select=id&limit=1', 'PRESENT'],
  ['POSCTL', '0149 intake.purge_status', 'aie_document_intake?select=purge_status&limit=1', 'PRESENT'],
  ['POSCTL', '0150 aie_ai_cost_ledger', 'aie_ai_cost_ledger?select=id&limit=1', 'PRESENT'],
  ['POSCTL', '0144 review_decision.correction_field_name', 'aie_review_decision?select=correction_field_name&limit=1', 'PRESENT'],
  ['POSCTL', '0044 ii_fund_holdings_snapshots', 'ii_fund_holdings_snapshots?select=id&limit=1', 'PRESENT'],
  ['POSCTL', '0033 ii_prices_nav', 'ii_prices_nav?select=id&limit=1', 'PRESENT'],
  // --- 0153 (PC5 governed resolution) ---
  ['0153', 'ii_ownership_allocation table', 'ii_ownership_allocation?select=id&limit=1', '?'],
  ['0153', 'review_decision.original_value_at_decision', 'aie_review_decision?select=original_value_at_decision&limit=1', '?'],
  ['0153', 'review_decision.parser_version_at_decision', 'aie_review_decision?select=parser_version_at_decision&limit=1', '?'],
  ['0153', 'review_decision.resulting_reconciliation_at', 'aie_review_decision?select=resulting_reconciliation_at&limit=1', '?'],
  // --- 0155 (PC6 reference market data) ---
  ['0155', 'ii_scheme_master table', 'ii_scheme_master?select=id&limit=1', '?'],
  ['0155', 'ii_reference_import_batches table', 'ii_reference_import_batches?select=id&limit=1', '?'],
  ['0155', 'ii_risk_free_methodology table', 'ii_risk_free_methodology?select=id&limit=1', '?'],
  ['0155', 'ii_reference_job_control table', 'ii_reference_job_control?select=job_key&limit=1', '?'],
  // --- 0157 (PC7 look-through foundation) ---
  ['0157', 'snapshots.scheme_master_id', 'ii_fund_holdings_snapshots?select=scheme_master_id&limit=1', '?'],
  ['0157', 'snapshots.resolved_weight_total_pct', 'ii_fund_holdings_snapshots?select=resolved_weight_total_pct&limit=1', '?'],
  ['0157', 'lines.industry_or_rating_raw', 'ii_fund_holdings_lines?select=industry_or_rating_raw&limit=1', '?'],
];

async function runEnvironment(label, baseUrl, key) {
  const rows = [];
  for (const [group, name, q, expected] of TARGETS) {
    const r = await probe(baseUrl, key, q);
    const state = r.ok ? 'PRESENT' : r.code === 'PGRST205' || r.code === '42703' ? 'ABSENT' : `ERROR(${r.code ?? r.status})`;
    rows.push({ group, name, state, code: r.code, expected });
  }
  console.log(`\n===== ${label} =====`);
  for (const r of rows) {
    const flag = r.expected !== '?' && r.expected !== r.state ? '   <<< CONTROL FAILED' : '';
    console.log(`  [${r.group.padEnd(6)}] ${r.name.padEnd(46)} ${r.state.padEnd(10)} ${r.code ?? ''}${flag}`);
  }
  const controlsOk = rows
    .filter((r) => r.expected !== '?')
    .every((r) => r.expected === r.state);
  console.log(`  CONTROLS: ${controlsOk ? 'ALL PASS — the method is sound' : 'FAILED — results below are not trustworthy'}`);
  for (const mig of ['0153', '0155', '0157']) {
    const g = rows.filter((r) => r.group === mig);
    const allAbsent = g.every((r) => r.state === 'ABSENT');
    const allPresent = g.every((r) => r.state === 'PRESENT');
    console.log(
      `  MIGRATION ${mig}: ${allAbsent ? 'NOT APPLIED' : allPresent ? 'APPLIED' : 'INDETERMINATE / PARTIAL'} (${g.length} objects probed)`,
    );
  }
  console.log('  MIGRATION 0154: NOT PROBEABLE read-only (CHECK + trigger only)');
  return { label, rows, controlsOk };
}

const { path, env, keyCount } = loadEnv();
console.log(`env file: ${path} (${keyCount} keys parsed)`);
console.log(`AIE_MASK_TOKEN_ENCRYPTION_KEY present: ${env.AIE_MASK_TOKEN_ENCRYPTION_KEY ? 'YES' : 'NO'}`);
console.log(`AIE_AI_PROVIDER present: ${env.AIE_AI_PROVIDER ? 'YES' : 'NO'}`);
const aieFlags = Object.keys(env).filter((k) => k.startsWith('AIE_'));
console.log(`AIE_* keys in env file: ${aieFlags.length} (${aieFlags.join(', ') || 'none'})`);

const dev = [env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY];
const prod = [env.PRODUCTION_SUPABASE_URL, env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY];
if (!dev[0] || !dev[1]) throw new Error('DEV url/key missing');
if (!prod[0] || !prod[1]) throw new Error('PRODUCTION url/key missing');
if (dev[0] === prod[0]) throw new Error('SAFETY: DEV url equals PRODUCTION url — refusing to run');

const results = [];
results.push(await runEnvironment('DEV', dev[0], dev[1]));
results.push(await runEnvironment('PRODUCTION (READ-ONLY)', prod[0], prod[1]));

console.log('\n===== SUMMARY =====');
console.log(`writes performed: 0   rpcs called: 0   ddl executed: 0   rows created: 0`);
console.log(`controls: ${results.every((r) => r.controlsOk) ? 'all pass on both environments' : 'FAILURE — see above'}`);
