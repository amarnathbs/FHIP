/**
 * M11 — follow-up read-only probe of the PRODUCTION deltas the Z.2 probe
 * surfaced against M1's recorded counts:
 *
 *   ii_document_parse_runs      M1 recorded 34   -> now 35
 *   ii_reconciliation_cases     M1 recorded 126  -> now 127
 *   aie_ai_cost_ledger          expected 0 rows  -> 1 row
 *
 * READ-ONLY. GET only. No PAN, folio number, holder name, scheme name or raw
 * statement text is printed; ids are truncated to an 8-character prefix.
 */
import fs from 'node:fs';

const p = ['.env.local', 'D:/FHIP/.env.local'].find((x) => fs.existsSync(x));
const env = {};
for (const raw of fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const l = raw.trim();
  if (!l || l.startsWith('#')) continue;
  const i = l.indexOf('=');
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}
const BASE = env.PRODUCTION_SUPABASE_URL.replace(/\/$/, '');
const KEY = env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;

async function get(q) {
  const r = await fetch(`${BASE}/rest/v1/${q}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  });
  if (!r.ok) {
    let b = null;
    try { b = await r.json(); } catch { /* ignore */ }
    return { ok: false, code: b?.code ?? r.status, message: b?.message };
  }
  return { ok: true, data: await r.json() };
}
const s = (v) => (v == null ? null : String(v).slice(0, 8));

console.log('=== M11 — PRODUCTION delta probe (READ-ONLY) ===\n');

console.log('--- ii_document_parse_runs: newest 5 ---');
const runs = await get('ii_document_parse_runs?select=id,run_status,started_at,completed_at,parser_code,parser_version,accounts_found,schemes_found,transactions_found,password_required&order=started_at.desc&limit=5');
if (runs.ok) {
  for (const r of runs.data) {
    console.log(`  ${s(r.id)} ${String(r.run_status).padEnd(9)} started=${r.started_at} parser=${r.parser_code}@${r.parser_version} acc=${r.accounts_found} sch=${r.schemes_found} txn=${r.transactions_found} pwReq=${r.password_required}`);
  }
} else console.log(`  ERR ${runs.code} ${runs.message}`);

const all = await get('ii_document_parse_runs?select=run_status,started_at&limit=500');
if (all.ok) {
  const b = {};
  for (const r of all.data) b[r.run_status] = (b[r.run_status] ?? 0) + 1;
  console.log(`  total=${all.data.length}  byStatus=${JSON.stringify(b)}`);
}

console.log('\n--- ii_reconciliation_cases: newest 5 + breakdown ---');
const c = await get('ii_reconciliation_cases?select=id,discrepancy_type,status,opened_at,resolved_at,subject_type&order=opened_at.desc&limit=500');
if (c.ok) {
  for (const x of c.data.slice(0, 5)) {
    console.log(`  ${s(x.id)} ${String(x.discrepancy_type).padEnd(28)} ${String(x.status).padEnd(8)} subj=${x.subject_type} opened=${x.opened_at}`);
  }
  const bt = {}, bs = {};
  for (const x of c.data) { bt[x.discrepancy_type] = (bt[x.discrepancy_type] ?? 0) + 1; bs[x.status] = (bs[x.status] ?? 0) + 1; }
  console.log(`  total=${c.data.length}  byType=${JSON.stringify(bt)}  byStatus=${JSON.stringify(bs)}`);
} else console.log(`  ERR ${c.code} ${c.message}`);

console.log('\n--- ii_source_documents on production (newest 10) ---');
const d = await get('ii_source_documents?select=id,parse_status,created_at&order=created_at.desc&limit=10');
if (d.ok) for (const x of d.data) console.log(`  ${s(x.id)} parse_status=${x.parse_status} created=${x.created_at}`);
else console.log(`  ERR ${d.code} ${d.message}`);

console.log('\n--- aie_ai_cost_ledger: the single production row ---');
const ledger = await get('aie_ai_cost_ledger?select=*&limit=5');
if (ledger.ok) for (const row of ledger.data) console.log(`  ${JSON.stringify(row)}`);
else console.log(`  ERR ${ledger.code} ${ledger.message}`);

console.log('\n--- every other AIE table on production ---');
for (const t of ['aie_ai_cost_attempt', 'aie_ai_completion_attempt', 'aie_audit_event', 'aie_parser_attempt', 'aie_masking_summary', 'aie_write_batch', 'aie_ii_adapter_link', 'aie_insurance_adapter_link', 'aie_processing_transition', 'aie_mask_token_map']) {
  const r = await fetch(`${BASE}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' } });
  console.log(`  ${t.padEnd(30)}: ${r.headers.get('content-range') ?? `ERR ${r.status}`}`);
}

console.log('\nwrites performed: 0   rows created: 0');
