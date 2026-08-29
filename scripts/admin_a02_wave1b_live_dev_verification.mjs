// A0.2 Wave 1B — LIVE DEV verification. RUN ONLY AFTER migration 0109
// (supabase/migrations/0109_admin_recommendation_upsert_atomicity.sql) has
// been applied to DEV (https://vqycarelcoijzwlpkpcz.supabase.co). Same
// constraints/methodology as scripts/admin_a02_wave1_live_dev_verification.mjs
// (no Supabase CLI auth, no direct Postgres connection string in this
// environment — a human applies the migration via the SQL Editor).
//
// Creates its own disposable W1B_-prefixed fixtures, cleans them up in a
// finally block, independently re-queries afterward to prove cleanup
// actually happened.
//
// Usage: node scripts/admin_a02_wave1b_live_dev_verification.mjs
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

const CODE_UPDATE = 'W1B_LIVE_UPDATE';
const CODE_CREATE = 'W1B_LIVE_CREATE';
const CODE_INVARIANT = 'W1B_LIVE_INVARIANT';
const ALL_CODES = [CODE_UPDATE, CODE_CREATE, CODE_INVARIANT];

async function insertMaster(code, isActive = false) {
  const { error } = await admin.from('action_recommendation_master').upsert(
    { recommendation_code: code, forecast_category: 'debt', sub_category: 'overall_variance', scenario_name: 'A0.2 Wave 1B live-DEV fixture — safe to delete', forecast_status: 'on_track', severity: 'medium', action_type: 'reduce_debt', action_title_template: 'Wave 1B test fixture', action_content_template: 'Wave 1B test fixture — delete me', is_active: isActive },
    { onConflict: 'recommendation_code' }
  );
  if (error) throw new Error(`insertMaster(${code}) failed: ${error.message}`);
  const { data } = await admin.from('action_recommendation_master').select('id').eq('recommendation_code', code).single();
  return data.id;
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
    console.log('=== 1. Valid update succeeds (master + conditions atomic) ===');
    const idUpdate = await insertMaster(CODE_UPDATE, false);
    await seedConditions(CODE_UPDATE, 2);
    const { data: r1, error: e1 } = await admin.rpc('admin_upsert_recommendation_atomic', {
      p_id: idUpdate,
      p_master: { scenario_name: 'updated live' },
      p_conditions: [{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'goal', evaluation_order: 1 }],
      p_clear_conditions: false,
    });
    check('valid update RPC succeeds', !e1, e1?.message);
    check('conditionsReplaced=2, conditionsInserted=1', r1?.conditionsReplaced === 2 && r1?.conditionsInserted === 1, JSON.stringify(r1));
    check('DB reflects exactly 1 condition now', (await countConditions(CODE_UPDATE)) === 1);

    console.log('\n=== 2. Invalid import produces a rejection; zero mutation ===');
    const before2 = await countConditions(CODE_UPDATE);
    const { error: e2 } = await admin.rpc('admin_upsert_recommendation_atomic', { p_id: idUpdate, p_master: {}, p_conditions: [{ field_name: null, operator: 'equals', comparison_value: 'x' }], p_clear_conditions: false });
    check('invalid conditions row (null field_name) is rejected', !!e2, e2?.message);
    check('conditions unchanged after the rejected call', (await countConditions(CODE_UPDATE)) === before2);

    console.log('\n=== 3. Controlled DB failure rolls back everything; existing conditions survive ===');
    const { data: beforeMaster } = await admin.from('action_recommendation_master').select('scenario_name').eq('id', idUpdate).single();
    const { error: e3 } = await admin.rpc('admin_upsert_recommendation_atomic', { p_id: idUpdate, p_master: { scenario_name: 'should not stick' }, p_conditions: [{ field_name: null, operator: 'equals', comparison_value: 'x' }], p_clear_conditions: false });
    check('controlled failure rejected', !!e3);
    const { data: afterMaster } = await admin.from('action_recommendation_master').select('scenario_name').eq('id', idUpdate).single();
    check('master scenario_name rolled back (never committed)', afterMaster.scenario_name === beforeMaster.scenario_name);
    check('conditions still survive at their pre-failure count', (await countConditions(CODE_UPDATE)) === before2);

    console.log('\n=== 4. Atomic create ===');
    const { data: r4, error: e4 } = await admin.rpc('admin_upsert_recommendation_atomic', {
      p_id: null,
      p_master: { recommendation_code: CODE_CREATE, forecast_category: 'debt', sub_category: 'x', scenario_name: 'live create', forecast_status: 'on_track', severity: 'low', action_type: 'x', action_title_template: 'T', action_content_template: 'C', is_active: true },
      p_conditions: [{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'debt', evaluation_order: 1 }],
      p_clear_conditions: false,
    });
    check('create RPC succeeds', !e4, e4?.message);
    check('created=true, 1 condition inserted', r4?.created === true && r4?.conditionsInserted === 1, JSON.stringify(r4));

    console.log('\n=== 5. Active + zero-conditions invariant, live ===');
    const idInv = await insertMaster(CODE_INVARIANT, false);
    const { error: e5 } = await admin.rpc('admin_upsert_recommendation_atomic', { p_id: idInv, p_master: { is_active: true }, p_conditions: null, p_clear_conditions: false });
    check('activating a zero-condition, non-unconditional recommendation is rejected live', !!e5, e5?.message);
    const { error: e5b } = await admin.rpc('admin_upsert_recommendation_atomic', { p_id: idInv, p_master: { is_active: true, matches_unconditionally: true }, p_conditions: null, p_clear_conditions: false });
    check('the same activation succeeds once matches_unconditionally=true is set explicitly', !e5b, e5b?.message);

    console.log('\n=== 6. Non-Admin access is denied ===');
    const { error: e6 } = await anon.rpc('admin_upsert_recommendation_atomic', { p_id: null, p_master: null, p_conditions: null, p_clear_conditions: false });
    check('anon-key direct RPC call is denied', !!e6 && /permission denied|not find the function/i.test(e6.message ?? ''), e6?.message);

    console.log('\n=== 7. No unrelated Recommendation data changed ===');
    const { count: masterDuring } = await admin.from('action_recommendation_master').select('*', { count: 'exact', head: true });
    check('master count grew by exactly the 3 fixtures added here', masterDuring === masterBefore + 3, `before=${masterBefore} during=${masterDuring}`);
  } finally {
    await cleanup();
  }

  const { count: masterAfter } = await admin.from('action_recommendation_master').select('*', { count: 'exact', head: true });
  const { count: condAfter } = await admin.from('action_recommendation_conditions').select('*', { count: 'exact', head: true });
  console.log(`\nAFTER CLEANUP: action_recommendation_master=${masterAfter} (expected ${masterBefore}), action_recommendation_conditions=${condAfter} (expected ${condBefore})`);
  check('post-cleanup master count matches pre-test baseline exactly', masterAfter === masterBefore, `${masterAfter} vs ${masterBefore}`);
  check('post-cleanup conditions count matches pre-test baseline exactly', condAfter === condBefore, `${condAfter} vs ${condBefore}`);

  console.log(`\n${'='.repeat(70)}\nWAVE 1B LIVE-DEV VERIFICATION: ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('LIVE-DEV VERIFICATION SCRIPT CRASHED:', e);
  await cleanup().catch(() => {});
  process.exit(2);
});
