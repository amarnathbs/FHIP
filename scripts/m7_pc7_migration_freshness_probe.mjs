// M7 (Part O) — PC7 migration-number freshness + prerequisite probe.
//
// Same three-source discipline M5/M6 used, because the standing finding of this
// whole mission is that ANY single source under-reports the next free number:
//
//   1. this branch's supabase/migrations folder
//   2. every git ref's supabase/migrations folder (done by the caller; PC7's own
//      carried-forward fact is that 0156 is claimed by the SEPARATE
//      `fix/app-review-findings-2026-09-15` branch, not by this mission)
//   3. the `supabase_migrations.schema_migrations` ledger on DEV *and* production
//
// It additionally answers the one question PC7's evidence standard depends on:
// **is migration 0155 (PC6's schema) applied yet?** If it is not, every PC7
// claim that depends on reading ii_scheme_master is schema-level (PGlite) proof
// only, and this report says so rather than pretending.
//
// Reads only. Creates nothing, writes nothing, prints no credential values.
import fs from 'node:fs';
import path from 'node:path';

// BOM+CRLF-safe .env.local parser (M3-OPEN-3).
const ENV_CANDIDATES = ['.env.local', path.join('D:', 'FHIP', '.env.local')];
let raw = '';
let envPath = null;
for (const c of ENV_CANDIDATES) {
  if (fs.existsSync(c)) {
    raw = fs.readFileSync(c, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    envPath = c;
    break;
  }
}
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
console.log(`[env] .env.local read from: ${envPath ?? 'NOT FOUND'} (${raw.length} chars)`);

const ENVS = [
  { label: 'DEV', url: pick('NEXT_PUBLIC_SUPABASE_URL'), key: pick('SUPABASE_SERVICE_ROLE_KEY') },
  { label: 'PRODUCTION', url: pick('PRODUCTION_SUPABASE_URL'), key: pick('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY') },
];

// Objects PC7 intends to INTRODUCE. A PRESENT result here is a collision.
const PLANNED_OBJECTS = [
  ['ii_fund_holdings_disclosure_sources', '*'],
  ['ii_lookthrough_coverage_policy', '*'],
];

// Objects PC7 intends to EXTEND or READ. ABSENT = prerequisite gap.
const REQUIRED_OBJECTS = [
  ['ii_instruments', 'id'],
  ['ii_sources', 'id'],
  ['ii_fund_holdings', 'fund_instrument_id'],
  ['ii_fund_holdings_snapshots', 'holdings_as_of_date'],
  ['ii_fund_holdings_lines', 'weight_pct'],
  ['ii_security_classifications', 'id'],
];

// PC6 dependencies. ABSENT means migration 0155 is still unapplied, which
// bounds what PC7 can prove live.
const PC6_OBJECTS = [
  ['ii_scheme_master', 'amfi_scheme_code'],
  ['ii_scheme_alias_history', 'instrument_id'],
  ['ii_reference_import_batches', 'batch_kind'],
  ['ii_reference_import_rejections', 'batch_id'],
  ['ii_reference_job_control', 'job_key'],
  ['ii_reference_corrections', 'target_table'],
];

const dir = path.join('supabase', 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
const repoMax = files.reduce((a, f) => Math.max(a, parseInt(/^(\d+)_/.exec(f)[1], 10)), 0);
console.log(`[source 1] this branch supabase/migrations max = ${String(repoMax).padStart(4, '0')} (${files.length} files)`);

const results = { repoMax, ledgerMax: {}, has0155: {}, collisions: [], missing: [], pc6Absent: [] };

for (const env of ENVS) {
  console.log(`\n=== ${env.label} (${env.url ? new URL(env.url).host : 'MISSING'}) ===`);
  if (!env.url || !env.key) {
    console.log('  SKIPPED — credentials not present');
    results.ledgerMax[env.label] = null;
    continue;
  }

  const res = await fetch(`${env.url}/rest/v1/schema_migrations?select=version&order=version.desc&limit=30`, {
    headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, 'Accept-Profile': 'supabase_migrations' },
  });
  if (res.ok) {
    const rows = await res.json();
    const versions = rows.map((r) => String(r.version));
    const nums = versions
      .map((v) => {
        const m = /^(\d{4})(?!\d)/.exec(v) || /(\d{4})$/.exec(v);
        return m ? parseInt(m[1], 10) : NaN;
      })
      .filter((n) => Number.isFinite(n) && n < 10000);
    const max = nums.length ? Math.max(...nums) : 0;
    results.ledgerMax[env.label] = max;
    console.log(`  [source 3] top versions: ${versions.slice(0, 10).join(', ')}`);
    console.log(`  [source 3] parsed 4-digit max = ${max ? String(max).padStart(4, '0') : 'none parseable'}`);
  } else {
    results.ledgerMax[env.label] = null;
    console.log(`  [source 3] schema_migrations UNREADABLE — HTTP ${res.status}`);
  }

  for (const [table, column] of PLANNED_OBJECTS) {
    const r = await fetch(`${env.url}/rest/v1/${table}?select=${column === '*' ? '*' : column}&limit=1`, {
      headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
    });
    if (r.ok) results.collisions.push(`${env.label}:${table}`);
    console.log(`  [planned] ${table}: ${r.ok ? '*** ALREADY EXISTS — COLLISION ***' : `absent (HTTP ${r.status})`}`);
  }

  for (const [table, column] of REQUIRED_OBJECTS) {
    const r = await fetch(`${env.url}/rest/v1/${table}?select=${column}&limit=1`, {
      headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
    });
    if (!r.ok) results.missing.push(`${env.label}:${table}.${column}`);
    console.log(`  [prereq]  ${table}.${column}: ${r.ok ? 'PRESENT' : `ABSENT (HTTP ${r.status})`}`);
  }

  let pc6Present = 0;
  for (const [table, column] of PC6_OBJECTS) {
    const r = await fetch(`${env.url}/rest/v1/${table}?select=${column}&limit=1`, {
      headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
    });
    if (r.ok) pc6Present++;
    else results.pc6Absent.push(`${env.label}:${table}`);
    console.log(`  [pc6/0155] ${table}.${column}: ${r.ok ? 'PRESENT' : `ABSENT (HTTP ${r.status})`}`);
  }
  results.has0155[env.label] = pc6Present === PC6_OBJECTS.length;
  console.log(`  [pc6/0155] migration 0155 applied on ${env.label}? ${results.has0155[env.label] ? 'YES' : `NO (${pc6Present}/${PC6_OBJECTS.length} objects present)`}`);

  for (const table of ['ii_instruments', 'ii_fund_holdings', 'ii_fund_holdings_snapshots', 'ii_fund_holdings_lines', 'ii_security_classifications', 'ii_sources']) {
    const r = await fetch(`${env.url}/rest/v1/${table}?select=id`, {
      headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = r.headers.get('content-range');
    console.log(`  [rows]    ${table}: ${r.ok ? (cr ? cr.split('/')[1] : '?') : `ERR ${r.status}`}`);
  }
}

console.log('\n--- SUMMARY ---');
console.log(JSON.stringify(results, null, 2));
const overall = Math.max(results.repoMax, ...Object.values(results.ledgerMax).map((v) => v || 0));
console.log(`NEXT FREE (this branch + ledgers) = ${String(overall + 1).padStart(4, '0')}`);
console.log('NOTE: git-ref sweep separately confirms 0156 is claimed by fix/app-review-findings-2026-09-15.');
