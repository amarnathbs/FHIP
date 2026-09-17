/**
 * M11 — Part Z.21 (synthetic residue) fresh read-only count of DEV state.
 *
 * Confirms, rather than inherits: the AIE/PC5/PC7 tables this mission's
 * live-DEV proofs wrote to are back to zero, and the ONE named non-zero
 * exception — OPS-PC7-2's 19 orphan snapshot headers — is still exactly what
 * M7 described (headers with no constituent lines), still not cleaned.
 *
 * READ-ONLY. GET only. No writes, no RPC, no DDL.
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
const BASE = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (BASE === env.PRODUCTION_SUPABASE_URL.replace(/\/$/, '')) throw new Error('SAFETY: dev url == production url');

async function count(table, filter = '') {
  const r = await fetch(`${BASE}/rest/v1/${table}?select=*${filter}&limit=1`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  const cr = r.headers.get('content-range');
  if (!cr) return `ERR ${r.status}`;
  return cr.split('/')[1];
}

console.log('=== M11 — DEV residue probe (READ-ONLY) ===\n');
console.log('--- AIE / PC5 tables the live-DEV proofs wrote to (expect 0) ---');
for (const t of ['aie_document_intake', 'aie_extraction_run', 'aie_field_candidate', 'aie_parser_attempt', 'aie_unresolved_item', 'aie_reconciliation_run', 'aie_review_decision', 'aie_audit_event', 'aie_mask_token_map', 'aie_masking_summary', 'aie_ai_completion_attempt', 'aie_ai_cost_attempt']) {
  console.log(`  ${t.padEnd(30)}: ${await count(t)}`);
}

console.log('\n--- PC7 look-through tables (OPS-PC7-2 is the named non-zero exception) ---');
console.log(`  ii_fund_holdings_snapshots    : ${await count('ii_fund_holdings_snapshots')}`);
console.log(`  ii_fund_holdings_lines        : ${await count('ii_fund_holdings_lines')}`);
console.log(`  ii_fund_holdings (R1 shape)   : ${await count('ii_fund_holdings')}`);
console.log(`  snapshots with source_id NULL : ${await count('ii_fund_holdings_snapshots', '&source_id=is.null')}`);
console.log(`  ii_prices_nav                 : ${await count('ii_prices_nav')}`);
console.log(`  ii_risk_free_rates            : ${await count('ii_risk_free_rates')}`);
console.log(`  ii_benchmarks                 : ${await count('ii_benchmarks')}`);

console.log('\n--- PC5 allocation table (0153 was applied to DEV mid-phase; expect 0 rows after cleanup) ---');
console.log(`  ii_ownership_allocation       : ${await count('ii_ownership_allocation')}`);

console.log('\nwrites performed: 0   rows created: 0');
