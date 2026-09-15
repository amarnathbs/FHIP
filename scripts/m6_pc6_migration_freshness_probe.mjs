// M6 (Part N) — PC6 migration-number freshness probe.
//
// The standing pattern this mission has repeatedly found is that the repo's own
// `check-migration-versions.mjs` UNDER-REPORTS the next free number, because
// migrations have historically been applied straight to DEV/production without
// the .sql file ever landing in `main`'s folder. So this probe asks THREE
// independent sources and takes the maximum:
//
//   1. this branch's supabase/migrations folder
//   2. origin/main's supabase/migrations folder (via git ls-tree, done by the caller)
//   3. the `supabase_migrations.schema_migrations` ledger on DEV *and* production
//
// It also probes, positively, for every object M6 intends to create, so that a
// collision with an object that already exists under a different migration
// number is caught before anything is written.
//
// Reads only. Creates nothing, writes nothing, prints no credential values.
import fs from 'node:fs';
import path from 'node:path';

// BOM+CRLF-safe .env.local parser (M3-OPEN-3: a naive line reader yields an
// empty environment against this file).
const ENV_CANDIDATES = ['.env.local', path.join('D:', 'FHIP', '.env.local')];
let raw = '';
for (const c of ENV_CANDIDATES) {
  if (fs.existsSync(c)) {
    raw = fs.readFileSync(c, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    break;
  }
}
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();

const ENVS = [
  { label: 'DEV', url: pick('NEXT_PUBLIC_SUPABASE_URL'), key: pick('SUPABASE_SERVICE_ROLE_KEY') },
  { label: 'PRODUCTION', url: pick('PRODUCTION_SUPABASE_URL'), key: pick('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY') },
];

// Objects M6/PC6 intends to introduce. A PRESENT result here is a collision.
const PLANNED_OBJECTS = [
  ['ii_scheme_master', '*'],
  ['ii_scheme_alias_history', '*'],
  ['ii_reference_import_batches', '*'],
  ['ii_reference_source_config', '*'],
  ['ii_reference_corrections', '*'],
];

// Objects M6/PC6 intends to EXTEND. An ABSENT result here is a prerequisite gap.
const REQUIRED_OBJECTS = [
  ['ii_instruments', 'plan_type'],
  ['ii_instrument_identifiers', 'identifier_scheme'],
  ['ii_prices_nav', 'quality_status'],
  ['ii_benchmarks', 'return_type'],
  ['ii_benchmark_series', 'quality_status'],
  ['ii_instrument_benchmarks', 'effective_from'],
  ['ii_risk_free_rates', 'annualised_rate'],
  ['ii_analytics_results', 'input_snapshot_version'],
];

const dir = path.join('supabase', 'migrations');
const repoMax = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .reduce((a, f) => Math.max(a, parseInt(/^(\d+)_/.exec(f)[1], 10)), 0);
console.log(`[source 1] this branch supabase/migrations max = ${String(repoMax).padStart(4, '0')}`);

const results = { repoMax, ledgerMax: {}, collisions: [], missing: [] };

for (const env of ENVS) {
  console.log(`\n=== ${env.label} (${env.url ? new URL(env.url).host : 'MISSING'}) ===`);
  if (!env.url || !env.key) {
    console.log('  SKIPPED — credentials not present');
    continue;
  }

  // ---- ledger ---------------------------------------------------------------
  const res = await fetch(`${env.url}/rest/v1/schema_migrations?select=version&order=version.desc&limit=25`, {
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      'Accept-Profile': 'supabase_migrations',
    },
  });
  if (res.ok) {
    const rows = await res.json();
    const nums = rows
      .map((r) => String(r.version))
      .map((v) => {
        const m = /^(\d{4})(?!\d)/.exec(v) || /(\d{4})$/.exec(v);
        return m ? parseInt(m[1], 10) : NaN;
      })
      .filter((n) => Number.isFinite(n) && n < 10000);
    const max = nums.length ? Math.max(...nums) : 0;
    results.ledgerMax[env.label] = max;
    console.log(`  [source 3] schema_migrations top versions: ${rows.slice(0, 8).map((r) => r.version).join(', ')}`);
    console.log(`  [source 3] parsed 4-digit max = ${max ? String(max).padStart(4, '0') : 'none parseable'}`);
  } else {
    results.ledgerMax[env.label] = null;
    console.log(`  [source 3] schema_migrations UNREADABLE — HTTP ${res.status}`);
  }

  // ---- collision probe ------------------------------------------------------
  for (const [table, column] of PLANNED_OBJECTS) {
    const r = await fetch(`${env.url}/rest/v1/${table}?select=${column === '*' ? '*' : column}&limit=1`, {
      headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
    });
    const present = r.ok;
    if (present) results.collisions.push(`${env.label}:${table}`);
    console.log(`  [planned] ${table}: ${present ? '*** ALREADY EXISTS — COLLISION ***' : `absent (HTTP ${r.status})`}`);
  }

  // ---- prerequisite probe ---------------------------------------------------
  for (const [table, column] of REQUIRED_OBJECTS) {
    const r = await fetch(`${env.url}/rest/v1/${table}?select=${column}&limit=1`, {
      headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
    });
    if (!r.ok) results.missing.push(`${env.label}:${table}.${column}`);
    console.log(`  [prereq]  ${table}.${column}: ${r.ok ? 'PRESENT' : `ABSENT (HTTP ${r.status})`}`);
  }

  // ---- row counts for the reference tables PC6 populates ---------------------
  for (const table of ['ii_instruments', 'ii_prices_nav', 'ii_benchmarks', 'ii_benchmark_series', 'ii_instrument_benchmarks', 'ii_risk_free_rates']) {
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
console.log(`NEXT FREE MIGRATION NUMBER (max of all sources + 1) = ${String(overall + 1).padStart(4, '0')}`);
