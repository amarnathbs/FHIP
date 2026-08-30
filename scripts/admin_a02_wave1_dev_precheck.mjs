// A0.2 Wave 1 — DEV pre-check (read-only). Run BEFORE migration 0107 is
// applied, to record the exact starting state per spec section 11:
//   - Confirm the exact DEV project/environment (and that it is not
//     production).
//   - Record the migration state (does admin_import_recommendation_conditions
//     already exist? it must not).
//   - Record existing action_recommendation_master/_conditions row counts,
//     for the before/after data-reconciliation table in the completion
//     report.
//
// This environment has no Supabase CLI auth and no direct Postgres
// connection string (same constraint documented in
// scripts/fdh9_live_dev_certification.mjs) — DDL must be applied by a human
// via the Supabase SQL Editor. This script only ever reads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

console.log(`Target project URL: ${url}`);
console.log('This is the project used by every existing "live DEV" test in this repo (tests/unit/resources*LiveDev.test.ts, resourcesR1_1/R1_2, scripts/*_live_dev_certification.mjs) — never the production app (app.financialhealthplatform.com, deployed via Amplify, whose credentials are not present anywhere in this environment).\n');

const { count: masterCount, error: masterErr } = await admin.from('action_recommendation_master').select('*', { count: 'exact', head: true });
const { count: condCount, error: condErr } = await admin.from('action_recommendation_conditions').select('*', { count: 'exact', head: true });
console.log(`action_recommendation_master row count: ${masterCount} ${masterErr ? `(ERROR: ${masterErr.message})` : ''}`);
console.log(`action_recommendation_conditions row count: ${condCount} ${condErr ? `(ERROR: ${condErr.message})` : ''}`);

const { error: rpcErr } = await admin.rpc('admin_import_recommendation_conditions', { p_import: { groups: [] } });
if (rpcErr) {
  console.log(`\nadmin_import_recommendation_conditions RPC: NOT FOUND yet (expected before migration 0107 is applied) — ${rpcErr.code ?? ''} ${rpcErr.message}`);
} else {
  console.log('\nWARNING: admin_import_recommendation_conditions RPC ALREADY EXISTS. Migration 0107 (or an equivalent) may already be applied — investigate before proceeding.');
}

// Any pre-existing fixture rows from a prior, incompletely-cleaned run of
// this wave's own testing (defensive — should be empty on a first pass).
const { data: staleFixtures } = await admin.from('action_recommendation_master').select('recommendation_code').ilike('recommendation_code', 'A02W1_%');
console.log(`\nPre-existing A02W1_ test fixtures found: ${staleFixtures?.length ?? 0} ${staleFixtures?.length ? JSON.stringify(staleFixtures.map((r) => r.recommendation_code)) : ''}`);
