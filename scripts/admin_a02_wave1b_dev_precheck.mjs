// A0.2 Wave 1B — DEV pre-check (read-only). Run BEFORE migration 0109 is
// applied. Same methodology as scripts/admin_a02_wave1_dev_precheck.mjs.
//
// Additionally answers the real deployment-risk question migration 0109's
// own header discloses but does not fix: how many currently-active
// recommendations ALREADY have zero conditions today? The new deferred
// triggers only guard FUTURE writes — they never retroactively touch
// existing rows — so this is a pure read, not a prerequisite for applying
// the migration, but the Product Owner should see the real number.
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
console.log('Same DEV project as Wave 1 (vqycarelcoijzwlpkpcz.supabase.co) — never production.\n');

const { count: masterCount } = await admin.from('action_recommendation_master').select('*', { count: 'exact', head: true });
const { count: condCount } = await admin.from('action_recommendation_conditions').select('*', { count: 'exact', head: true });
console.log(`action_recommendation_master row count: ${masterCount}`);
console.log(`action_recommendation_conditions row count: ${condCount}`);

const { error: rpcErr } = await admin.rpc('admin_upsert_recommendation_atomic', { p_id: null, p_master: null, p_conditions: null, p_clear_conditions: false });
if (rpcErr && /could not find the function|does not exist/i.test(rpcErr.message)) {
  console.log(`\nadmin_upsert_recommendation_atomic RPC: NOT FOUND yet (expected before migration 0109 is applied) — ${rpcErr.code ?? ''} ${rpcErr.message}`);
} else if (rpcErr) {
  console.log(`\nadmin_upsert_recommendation_atomic RPC: EXISTS (call reached the function and errored on the null payload, as expected: ${rpcErr.message}) — migration 0109 is already applied.`);
} else {
  console.log('\nWARNING: RPC call with a null payload unexpectedly succeeded — investigate.');
}

const { data: colCheck } = await admin.from('action_recommendation_master').select('matches_unconditionally').limit(1);
console.log(`\nmatches_unconditionally column present: ${colCheck !== null}`);

// Real risk disclosure — paginate both tables (Supabase's 1000-row REST
// cap) to compute this exactly, not on a possibly-truncated sample.
async function fetchAllCodes() {
  const codes = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('action_recommendation_master').select('recommendation_code, is_active').range(from, from + 999);
    if (error) throw error;
    for (const row of data) codes.set(row.recommendation_code, row.is_active);
    if (data.length < 1000) break;
  }
  return codes;
}
async function fetchAllConditionCodes() {
  const withConditions = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('action_recommendation_conditions').select('recommendation_code').range(from, from + 999);
    if (error) throw error;
    for (const row of data) withConditions.add(row.recommendation_code);
    if (data.length < 1000) break;
  }
  return withConditions;
}
const allCodes = await fetchAllCodes();
const codesWithConditions = await fetchAllConditionCodes();
const activeZeroCondition = [...allCodes.entries()].filter(([code, isActive]) => isActive && !codesWithConditions.has(code));
console.log(`\nReal risk disclosure: ${activeZeroCondition.length} of ${masterCount} recommendations are CURRENTLY active with zero conditions (pre-existing, not caused by this migration — the new triggers do not retroactively touch them; they will only be re-checked the next time either RPC touches that row).`);
if (activeZeroCondition.length > 0 && activeZeroCondition.length <= 20) {
  console.log('Codes:', activeZeroCondition.map(([c]) => c).join(', '));
} else if (activeZeroCondition.length > 20) {
  console.log('First 20 codes:', activeZeroCondition.slice(0, 20).map(([c]) => c).join(', '));
}

const { data: staleFixtures } = await admin.from('action_recommendation_master').select('recommendation_code').ilike('recommendation_code', 'W1B_%');
console.log(`\nPre-existing W1B_ test fixtures found: ${staleFixtures?.length ?? 0} ${staleFixtures?.length ? JSON.stringify(staleFixtures.map((r) => r.recommendation_code)) : ''}`);
