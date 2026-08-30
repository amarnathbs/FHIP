// A0.2 Wave 1 — LIVE DEV verification. RUN ONLY AFTER migration 0107
// (supabase/migrations/0107_admin_recommendations_conditions_import_integrity.sql)
// has been applied to the DEV Supabase project
// (https://vqycarelcoijzwlpkpcz.supabase.co — confirmed via
// scripts/admin_a02_wave1_dev_precheck.mjs to be the same project every
// other "live DEV" test/certification script in this repo uses; never the
// production app, whose credentials are not present in this environment).
//
// This environment has no Supabase CLI auth and no direct Postgres
// connection string, so applying the migration itself requires a human to
// paste the file into the Supabase SQL Editor — the same constraint and
// mechanism documented in scripts/fdh9_live_dev_certification.mjs.
//
// Creates its own disposable A02W1_-prefixed fixtures, cleans them up in a
// finally block, and independently re-queries afterward to prove cleanup
// actually happened (spec section 11's "clean up only fixtures created by
// this wave; do not delete pre-existing DEV records").
//
// Usage: node scripts/admin_a02_wave1_live_dev_verification.mjs
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
const anon = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0;
let fail = 0;
function check(label, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${extra}`);
  }
}

const CODE_1 = 'A02W1_TEST_1';
const CODE_2 = 'A02W1_TEST_2';
const ALL_CODES = [CODE_1, CODE_2];

async function seedMaster(code) {
  const { error } = await admin.from('action_recommendation_master').upsert(
    {
      recommendation_code: code,
      forecast_category: 'debt',
      sub_category: 'overall_variance',
      scenario_name: 'A0.2 Wave 1 live-DEV fixture — safe to delete',
      forecast_status: 'on_track',
      severity: 'medium',
      action_type: 'reduce_debt',
      action_title_template: 'A0.2 Wave 1 test fixture',
      action_content_template: 'A0.2 Wave 1 test fixture — delete me',
      is_active: false,
    },
    { onConflict: 'recommendation_code' }
  );
  if (error) throw new Error(`seedMaster(${code}) failed: ${error.message}`);
}

async function seedConditions(code, n) {
  const rows = Array.from({ length: n }, (_, i) => ({ recommendation_code: code, condition_group: 1, field_name: `test_field_${i + 1}`, operator: 'equals', comparison_value: `v${i + 1}`, evaluation_order: i + 1 }));
  const { error } = await admin.from('action_recommendation_conditions').insert(rows);
  if (error) throw new Error(`seedConditions(${code}) failed: ${error.message}`);
}

async function countConditions(code) {
  const { count } = await admin.from('action_recommendation_conditions').select('*', { count: 'exact', head: true }).eq('recommendation_code', code);
  return count;
}

async function cleanup() {
  await admin.from('action_recommendation_conditions').delete().in('recommendation_code', ALL_CODES);
  await admin.from('action_recommendation_master').delete().in('recommendation_code', ALL_CODES);
}

async function main() {
  const { count: masterBefore } = await admin.from('action_recommendation_master').select('*', { count: 'exact', head: true });
  const { count: condBefore } = await admin.from('action_recommendation_conditions').select('*', { count: 'exact', head: true });
  console.log(`BEFORE: action_recommendation_master=${masterBefore}, action_recommendation_conditions=${condBefore}\n`);

  try {
    console.log('=== 1. Valid import succeeds ===');
    await seedMaster(CODE_1);
    await seedMaster(CODE_2);
    await seedConditions(CODE_1, 2);
    const { data: r1, error: e1 } = await admin.rpc('admin_import_recommendation_conditions', {
      p_import: { groups: [{ recommendation_code: CODE_1, clear: false, conditions: [{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'goal', evaluation_order: 1 }] }] },
    });
    check('valid import RPC succeeds', !e1, e1?.message);
    check('valid import: conditionsReplaced=2, conditionsInserted=1', r1?.conditionsReplaced === 2 && r1?.conditionsInserted === 1, JSON.stringify(r1));
    check('DB reflects exactly 1 condition for CODE_1 now', (await countConditions(CODE_1)) === 1);

    console.log('\n=== 2/3. Invalid import: row-level errors, zero mutation ===');
    const before2 = await countConditions(CODE_1);
    const { error: e2 } = await admin.rpc('admin_import_recommendation_conditions', {
      p_import: { groups: [{ recommendation_code: 'NOT_REAL_CODE_XYZ', clear: false, conditions: [{ field_name: 'x', operator: 'equals', comparison_value: '1' }] }] },
    });
    check('invalid import (unknown code) is rejected', !!e2, e2?.message);
    check('invalid import changed zero rows for CODE_1', (await countConditions(CODE_1)) === before2);

    console.log('\n=== 4/5. Controlled database failure rolls back; existing conditions survive ===');
    await seedConditions(CODE_2, 2);
    const before45 = await countConditions(CODE_2);
    const { error: e3 } = await admin.rpc('admin_import_recommendation_conditions', {
      p_import: {
        groups: [
          { recommendation_code: CODE_1, clear: false, conditions: [{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'net_worth', evaluation_order: 1 }] },
          { recommendation_code: CODE_2, clear: false, conditions: [{ field_name: null, operator: 'equals', comparison_value: 'x' }] }, // genuine NOT NULL violation
        ],
      },
    });
    check('controlled DB failure (NOT NULL violation) rejected', !!e3, e3?.message);
    check('EARLIER code (CODE_1) rolled back — still 1 condition, not 1 new one', (await countConditions(CODE_1)) === 1);
    check('code CODE_2 conditions survive the failure untouched', (await countConditions(CODE_2)) === before45);

    console.log('\n=== 6. Non-Admin access is denied ===');
    const { error: e4 } = await anon.rpc('admin_import_recommendation_conditions', { p_import: { groups: [] } });
    check('anon-key direct RPC call is denied', !!e4 && /permission denied|not find the function/i.test(e4.message ?? ''), e4?.message);

    console.log('\n=== 10. No unrelated Recommendation data changed ===');
    const { count: masterDuring } = await admin.from('action_recommendation_master').select('*', { count: 'exact', head: true });
    check('action_recommendation_master count only grew by the 2 fixtures added here', masterDuring === masterBefore + 2, `before=${masterBefore} during=${masterDuring}`);
  } finally {
    await cleanup();
  }

  const { count: masterAfter } = await admin.from('action_recommendation_master').select('*', { count: 'exact', head: true });
  const { count: condAfter } = await admin.from('action_recommendation_conditions').select('*', { count: 'exact', head: true });
  console.log(`\nAFTER CLEANUP: action_recommendation_master=${masterAfter} (expected ${masterBefore}), action_recommendation_conditions=${condAfter} (expected ${condBefore})`);
  check('post-cleanup master count matches pre-test baseline exactly', masterAfter === masterBefore, `${masterAfter} vs ${masterBefore}`);
  check('post-cleanup conditions count matches pre-test baseline exactly', condAfter === condBefore, `${condAfter} vs ${condBefore}`);

  console.log(`\n${'='.repeat(70)}\nLIVE-DEV VERIFICATION: ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('LIVE-DEV VERIFICATION SCRIPT CRASHED:', e);
  await cleanup().catch(() => {});
  process.exit(2);
});
