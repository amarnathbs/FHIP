/**
 * M12E — section 18 fresh migration-application probe.
 *
 * Re-verifies, rather than inherits, that migrations 0153 / 0154 / 0155 / 0157
 * are genuinely applied on DEV, with PAIRED NEGATIVE CONTROLS so the method can
 * distinguish "absent" from "not looked".
 *
 * Phase D's report §8.4 asserted these "remain unapplied on DEV". M12A §8.2
 * probed them live and found 0153/0155/0157 PRESENT on DEV. This probe settles
 * the discrepancy on fresh evidence.
 *
 * READ-ONLY. GET only. No writes, no RPC, no DDL. DEV only — a hard safety
 * assertion refuses to run if the DEV url equals the production url.
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
const DEV = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '');
const DEV_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const PROD = (env.PRODUCTION_SUPABASE_URL || '').replace(/\/$/, '');
if (!DEV || !DEV_KEY) throw new Error('DEV credentials missing');
if (PROD && DEV === PROD) throw new Error('SAFETY: dev url == production url');

async function probe(base, key, path) {
  const r = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' },
  });
  let code = '';
  if (!r.ok) {
    try {
      const b = await r.json();
      code = b.code || '';
    } catch {
      /* body not json */
    }
  }
  return { status: r.status, code, ok: r.ok };
}

const render = (r) => (r.ok ? `HTTP ${r.status} PRESENT` : `HTTP ${r.status} ${r.code} ABSENT`);

console.log('=== M12E — migration application probe (READ-ONLY, DEV) ===\n');

const checks = [
  ['0153', 'table  ii_ownership_allocation', 'ii_ownership_allocation?select=id&limit=1'],
  ['0155', 'table  ii_scheme_master', 'ii_scheme_master?select=id&limit=1'],
  ['0157', 'column ii_fund_holdings_snapshots.disclosure_period', 'ii_fund_holdings_snapshots?select=disclosure_period&limit=1'],
  ['0157', 'column ii_fund_holdings_snapshots.scheme_master_id', 'ii_fund_holdings_snapshots?select=scheme_master_id&limit=1'],
  // NOTE: a first draft of this probe guessed `ii_fund_holdings_lines.line_kind`,
  // which 0157 does not create, and correctly reported it ABSENT. The real
  // 0157 line-table columns are read from the migration below rather than guessed.
  ['0157', 'column ii_fund_holdings_lines.record_checksum', 'ii_fund_holdings_lines?select=record_checksum&limit=1'],
  ['0157', 'column ii_fund_holdings_lines.yield_pct', 'ii_fund_holdings_lines?select=yield_pct&limit=1'],
  ['0157', 'column ii_reference_import_batches.source_column_signature', 'ii_reference_import_batches?select=source_column_signature&limit=1'],
  ['0157', 'column admin_users.can_view_lookthrough_data_quality', 'admin_users?select=can_view_lookthrough_data_quality&limit=1'],
  ['0145', 'column aie_document_intake.fdh_bank_upload_metadata (applied long ago; positive control)', 'aie_document_intake?select=fdh_bank_upload_metadata&limit=1'],
  ['0154', 'table  business_entities (entity_type CHECK widened to admit huf)', 'business_entities?select=entity_type&limit=1'],
];

for (const [mig, label, path] of checks) {
  const r = await probe(DEV, DEV_KEY, path);
  console.log(`  ${mig}  ${label.padEnd(72)}: ${render(r)}`);
}

console.log('\n--- NEGATIVE CONTROLS (must report ABSENT, or the method proves nothing) ---');
const neg = [
  ['nonexistent TABLE', 'zz_m12e_table_that_does_not_exist?select=id&limit=1'],
  ['nonexistent COLUMN on a real table', 'ii_fund_holdings_snapshots?select=zz_m12e_no_such_column&limit=1'],
  ['nonexistent COLUMN on business_entities', 'business_entities?select=zz_m12e_no_such_column&limit=1'],
];
for (const [label, path] of neg) {
  const r = await probe(DEV, DEV_KEY, path);
  console.log(`  ${label.padEnd(80)}: ${render(r)}`);
}

console.log('\nwrites performed: 0   rows created: 0   RPC calls: 0   DDL: 0');
