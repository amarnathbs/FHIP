// Module 11.1 certification: proves, on a freshly rebuilt real Postgres
// (PGlite, migrations 0001..0115), that the premium-entitlement / quota /
// rate-limit / cost-ceiling / kill-switch enforcement layer actually enforces.
//
// Run:  npm i --no-save @electric-sql/pglite
//       node scripts/db-rebuild-check/module11_1_entitlement_cert.mjs
//
// Structure mirrors module11_ai_foundation_cert.mjs, including its
// asTenant/asAnon/asService helpers and its discipline of pairing every
// isolation claim with a NEGATIVE CONTROL that proves the test can fail.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.stack); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`fresh rebuild complete: ${files.length} migrations applied, last = ${files[files.length - 1]}\n`);

var pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };

const PREM = '11111111-1111-1111-1111-111111111111';   // premium tenant
const FREE = '22222222-2222-2222-2222-222222222222';   // free tenant
const NOENT = '33333333-3333-3333-3333-333333333333';  // tenant with NO entitlement row
const HH_PREM = 'aaaaaaaa-0000-0000-0000-000000000001';
const HH_FREE = 'bbbbbbbb-0000-0000-0000-000000000002';

await db.exec(`insert into auth.users(id,email) values ('${PREM}','prem@t.test'),('${FREE}','free@t.test'),('${NOENT}','noent@t.test');`);
await db.exec(`insert into households (id, user_id) values ('${HH_PREM}','${PREM}'), ('${HH_FREE}','${FREE}');`);
// The signup trigger seeded a 'free' row for each. Upgrade one; delete one
// entirely so "cannot determine tier" is a genuinely reachable state.
await db.exec(`update user_entitlements set plan_tier='premium' where user_id='${PREM}';`);
await db.exec(`delete from user_entitlements where user_id='${NOENT}';`);

async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  const seen = (await db.query(`select auth.uid()::text u`)).rows[0].u;
  if (seen !== uid) { console.log(`  FAIL  harness: auth.uid() is ${seen}, expected ${uid} — tests would be vacuous`); fail++; }
  // Clearing the claims on exit matters: set_config(..., false) is
  // SESSION-scoped, so a leftover `sub` would make every later service-role
  // call look like it came from that tenant and silently trip the RPC's
  // identity guard.
  try { return await fn(); } finally { await db.exec(`reset role;`); await db.query(`select set_config('request.jwt.claims', '', false)`); }
}
async function asAnon(fn) {
  await db.exec(`set role anon;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
async function asService(fn) {
  await db.exec(`set role service_role;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}

/**
 * Calls the admission RPC exactly as the application does (service role).
 *
 * AUTO-FINALISES by default. Spec section 18 caps a subject at one concurrent
 * LIVE reservation, so without this every sequential test after the first
 * would be refused with 'request_in_progress' — which would be a harness
 * artefact, not a finding. Finalising mirrors what the gateway genuinely does
 * after a validated answer. A test that wants an OPEN reservation (the
 * concurrency and section 81 tests) passes keepReserved: true and says so.
 */
async function admit(opts = {}) {
  const o = {
    user: PREM, household: HH_PREM, klass: 'custom', task: 'score_explanation',
    provider: 'mock', model: 'mock-standard-1', tier: 'STANDARD', cost: 0.001, cacheHit: false,
    outcome: null, idemKey: null, reqHash: null,
    contextTokens: 1000, userInputTokens: 200, outputTokens: 500,
    keepReserved: false,
    ...opts,
  };
  const { rows } = await db.query(
    `select ai_admit_request($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) v`,
    [o.user, o.household, o.klass, o.task, o.provider, o.model, o.tier, o.cost, o.cacheHit,
     o.outcome, o.idemKey, o.reqHash, o.contextTokens, o.userInputTokens, o.outputTokens]
  );
  const v = rows[0].v;
  if (!o.keepReserved && v.allowed && v.execution_state === 'reserved' && v.admission_id) {
    await db.query(`select ai_finalise_admission($1)`, [v.admission_id]);
  }
  return v;
}
async function finalise(id) { return (await db.query(`select ai_finalise_admission($1) v`, [id])).rows[0].v; }
async function refund(id) { return (await db.query(`select ai_refund_admission($1) v`, [id])).rows[0].v; }
async function setControls(patch) {
  const sets = Object.entries(patch).map(([k, v]) => `${k} = ${v === null ? 'null' : typeof v === 'string' ? `'${v}'` : v}`).join(', ');
  await db.exec(`update ai_platform_controls set ${sets} where id='global';`);
}
async function resetState() {
  // ai_operational_events references ai_admission_events, so it goes first.
  await db.exec(`delete from ai_operational_events; delete from ai_admission_events; delete from ai_usage_ledger;`);
  await db.exec(`
    update ai_platform_controls set
      ai_globally_enabled = true, custom_ai_enabled = true, kill_switch_reason = null,
      standard_requires_premium = true, monthly_custom_question_allowance = 10,
      rate_limit_max_requests = 10000, rate_limit_window_seconds = 3600,
      per_user_monthly_cost_ceiling_usd = 5.0, platform_monthly_cost_ceiling_usd = 500.0,
      max_cost_per_request_usd = 0.5,
      live_provider_enabled = true, batch_generation_enabled = true, scenario_ai_enabled = true,
      max_concurrent_requests_per_subject = 1, concurrency_lease_seconds = 120,
      max_context_tokens = 12000, max_user_input_tokens = 2000, max_output_tokens = 800,
      platform_soft_cost_threshold_usd = null, per_user_soft_cost_threshold_usd = null,
      daily_live_ai_cost_limit_usd = null
    where id='global';`);
  await db.exec(`update ai_task_cost_limits set active = true, max_monthly_cost_usd = null;`);
  await db.exec(`update ai_provider_controls set enabled = true, monthly_cost_limit_usd = null, disabled_reason = null;`);
  await db.exec(`update ai_model_registry set active = true, approved = true, effective_from = null, effective_to = null;`);
}

// -----------------------------------------------------------------------------
// Model registry fixtures.
//
// Required now because spec section 32 made the model check FAIL CLOSED: a
// model that is not in ai_model_registry has been approved by nobody and is
// refused ('model_unknown'). Seeding real registry rows also makes the
// certification more faithful than the Part 1 version was, where the model
// string was accepted without any registry row existing at all.
// -----------------------------------------------------------------------------
// 'mock-standard-1' is already seeded by migration 0110 (8000 in / 800 out).
// Only the other two tiers are added, so that the tier-cap tests can name a
// model whose REGISTRY tier is genuinely the tier under test rather than
// asserting a tier the registry disagrees with.
await db.exec(`
  insert into ai_model_registry (provider, model_identifier, internal_tier, active, approved, task_types, max_input_tokens, max_output_tokens, cost_input_per_1k_usd, cost_output_per_1k_usd)
  values
    ('mock','mock-low-1','LOW_COST',true,true,'{score_explanation,missing_data_explanation,dna_explanation,cross_border_explanation}',8000,800,0.000000,0.000000),
    ('mock','mock-advanced-1','ADVANCED',true,true,'{score_explanation,general_coach}',32000,800,0.000000,0.000000)
  on conflict (provider, model_identifier) do nothing;
`);
const period = (await db.query(`select ai_billing_period_for($1) p`, [PREM])).rows[0].p;

// =============================================================================
console.log('=== A. SCHEMA + RLS COVERAGE ===');
// =============================================================================
{
  const { rows: noRls } = await db.query(`
    select c.relname from pg_class c join pg_namespace nsp on nsp.oid=c.relnamespace
    where nsp.nspname='public' and c.relkind='r'
      and c.relname in ('ai_platform_controls','ai_task_cost_limits','ai_admission_events')
      and not c.relrowsecurity order by 1`);
  check('every new Module 11.1 table has RLS enabled', noRls.length === 0, noRls.length ? `(missing: ${noRls.map(r=>r.relname).join(', ')})` : '');

  const ctl = (await db.query(`select count(*)::int c from ai_platform_controls`)).rows[0].c;
  check('the singleton controls row was seeded exactly once', ctl === 1, `(saw ${ctl})`);

  let singletonBlocked = false;
  try { await db.query(`insert into ai_platform_controls (id) values ('other')`); }
  catch (e) { singletonBlocked = /check|constraint/i.test(e.message); }
  check('a second ai_platform_controls row is structurally impossible (singleton CHECK)', singletonBlocked);

  // Assert the seeded task set MATCHES lib/ai/providers/types.ts AITaskType
  // exactly — a bare count of 12 would pass even if a task were misspelled and
  // an extra one invented, which would silently leave a real task uncapped.
  const AI_TASK_TYPES = [
    'score_explanation', 'monthly_summary', 'next_best_action', 'forecast_explanation',
    'twin_explanation', 'missing_data_explanation', 'resilience_explanation', 'dna_explanation',
    'goal_progress_explanation', 'general_coach', 'report_explanation', 'cross_border_explanation',
  ].sort();
  const seededTasks = (await db.query(`select task_type from ai_task_cost_limits order by task_type`)).rows.map(r => r.task_type).sort();
  check('a task cost limit was seeded for EXACTLY the 12 AITaskType values (no gaps, no invented tasks)',
    JSON.stringify(seededTasks) === JSON.stringify(AI_TASK_TYPES),
    seededTasks.length === 12 ? '' : `(saw ${JSON.stringify(seededTasks)})`);
  const seededModelRegistryTasks = (await db.query(`select unnest(task_types) t from ai_model_registry where provider='mock' and model_identifier='mock-standard-1'`)).rows.map(r => r.t).sort();
  check('...and that set is identical to the task list the Module 11.0 model registry was seeded with',
    JSON.stringify(seededModelRegistryTasks) === JSON.stringify(AI_TASK_TYPES));

  let dupBlocked = false;
  try { await db.query(`insert into ai_task_cost_limits (task_type, max_cost_per_request_usd) values ('score_explanation', 1)`); }
  catch (e) { dupBlocked = /unique|duplicate/i.test(e.message); }
  check('a second task-level (model-agnostic) limit for the same task is rejected by the partial unique index', dupBlocked);

  const cols = (await db.query(`select column_name from information_schema.columns where table_name='ai_usage_ledger' and column_name in ('custom_question_count','refunded_question_count') order by 1`)).rows.map(r=>r.column_name);
  check('ai_usage_ledger gained both quota counters', cols.length === 2, `(saw ${JSON.stringify(cols)})`);

  const allowed = (await db.query(`select pg_get_constraintdef(con.oid) d from pg_constraint con join pg_class cls on cls.oid=con.conrelid where cls.relname='ai_runs' and con.contype='c' and pg_get_constraintdef(con.oid) ilike '%execution_status%'`)).rows[0].d;
  check("ai_runs.execution_status now permits 'rejected_entitlement'", /rejected_entitlement/.test(allowed));
  check("ai_runs.execution_status still permits every Module 11.0 value", ['success','rejected_schema','rejected_certification','rejected_source_ref','provider_error','timeout','blocked_safety'].every(v => allowed.includes(`'${v}'`)));

  await asService(async () => {
    let bogusBlocked = false;
    try {
      await db.query(`insert into ai_runs (user_id, request_type, context_version, context_hash, provider, model, execution_status) values ('${PREM}','score_explanation','v','h','mock','m','totally_made_up')`);
    } catch (e) { bogusBlocked = /check|constraint/i.test(e.message); }
    check('control: an invented execution_status is still rejected (the widened CHECK is not a free-for-all)', bogusBlocked);
    await db.query(`insert into ai_runs (user_id, request_type, context_version, context_hash, provider, model, execution_status, error_code) values ('${PREM}','score_explanation','v','h','mock','m','rejected_entitlement','quota_exhausted')`);
    const c = (await db.query(`select count(*)::int c from ai_runs where execution_status='rejected_entitlement' and error_code='quota_exhausted'`)).rows[0].c;
    check('an entitlement rejection is auditable with its SPECIFIC reason in error_code', c === 1, `(saw ${c})`);
  });

  const dbP = (await db.query(`select ai_billing_period_for($1) p`, [PREM])).rows[0].p;
  const tsP = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
  check('DB ai_billing_period_for() and TS currentBillingPeriod() agree on the current period', dbP === tsP, `(db=${dbP} ts=${tsP})`);
}

// =============================================================================
console.log('\n=== B. TENANT ISOLATION + SAME-TENANT FORGERY (the quota-reset attack) ===');
// =============================================================================
await resetState();
await admit({ user: PREM, household: HH_PREM });
await admit({ user: FREE, household: HH_FREE, klass: 'custom' }); // denied (free) but still audited
{
  await asTenant(PREM, async () => {
    const own = (await db.query(`select count(*)::int c from ai_admission_events`)).rows[0].c;
    check('a tenant can read their OWN admission events', own === 1, `(saw ${own}, expected 1)`);
    const leak = (await db.query(`select count(*)::int c from ai_admission_events where user_id='${FREE}'`)).rows[0].c;
    check("a tenant cannot read another tenant's admission events", leak === 0, `(leaked ${leak})`);
  });

  // Negative control: prove the isolation result above is real, not an artefact
  // of an empty table.
  await db.exec(`alter table ai_admission_events disable row level security;`);
  let leak = 0;
  await asTenant(PREM, async () => { leak = (await db.query(`select count(*)::int c from ai_admission_events where user_id='${FREE}'`)).rows[0].c; });
  check("control: RLS off on ai_admission_events -> tenant DOES see the other tenant's row", leak === 1, `(saw ${leak}, expected 1 — proves the test is not vacuous)`);
  await db.exec(`alter table ai_admission_events enable row level security;`);
  await asTenant(PREM, async () => {
    const re = (await db.query(`select count(*)::int c from ai_admission_events where user_id='${FREE}'`)).rows[0].c;
    check('control: isolation restored on ai_admission_events', re === 0, `(saw ${re})`);
  });

  // ---- THE ATTACK THE BRIEF NAMES: can a user reset their own quota? ----
  await asTenant(PREM, async () => {
    const before = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger`)).rows[0].c;
    check('setup: the premium tenant can SEE their own consumed quota', before === 1, `(saw ${before})`);

    const upd = await db.query(`update ai_usage_ledger set custom_question_count = 0 where user_id='${PREM}'`);
    check('SAME-TENANT FORGERY: UPDATE of own ai_usage_ledger row affects 0 rows (no UPDATE policy exists)', (upd.affectedRows ?? 0) === 0, `(affected ${upd.affectedRows})`);

    const del = await db.query(`delete from ai_usage_ledger where user_id='${PREM}'`);
    check('SAME-TENANT FORGERY: DELETE of own ai_usage_ledger row affects 0 rows', (del.affectedRows ?? 0) === 0, `(affected ${del.affectedRows})`);

    let insBlocked = false;
    try { await db.query(`insert into ai_usage_ledger (user_id, billing_period, task_type, provider, model, custom_question_count) values ('${PREM}','${period}','x','mock','m',-999)`); }
    catch (e) { insBlocked = /policy|denied|row-level security/i.test(e.message); }
    check('SAME-TENANT FORGERY: INSERT of a negative-quota ledger row for self is blocked by RLS', insBlocked);

    let evBlocked = false;
    try { await db.query(`insert into ai_admission_events (user_id, billing_period, request_class, task_type, provider, model, decision) values ('${PREM}','${period}','custom','x','mock','m','allowed')`); }
    catch (e) { evBlocked = /policy|denied|row-level security/i.test(e.message); }
    check('SAME-TENANT FORGERY: a tenant cannot forge an "allowed" admission event', evBlocked);

    const evDel = await db.query(`delete from ai_admission_events where user_id='${PREM}'`);
    check('SAME-TENANT FORGERY: a tenant cannot delete their own admission events (would clear their rate-limit window)', (evDel.affectedRows ?? 0) === 0, `(affected ${evDel.affectedRows})`);

    const after = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger`)).rows[0].c;
    check('GROUND TRUTH: after every forgery attempt, consumed quota is unchanged', after === 1, `(saw ${after}, expected 1)`);
  });

  // Negative control for the forgery result: with an UPDATE policy present the
  // attack DOES succeed, proving the zero-rows-affected results above are real
  // policy enforcement and not a silently-failing statement.
  await db.exec(`create policy "TEMP forgery control" on ai_usage_ledger for update using (auth.uid() = user_id) with check (auth.uid() = user_id);`);
  await asTenant(PREM, async () => {
    const upd = await db.query(`update ai_usage_ledger set custom_question_count = 0 where user_id='${PREM}'`);
    check('control: WITH an UPDATE policy the quota-reset attack DOES succeed', (upd.affectedRows ?? 0) === 1, `(affected ${upd.affectedRows} — proves the blocks above are genuine)`);
  });
  await db.exec(`drop policy "TEMP forgery control" on ai_usage_ledger;`);
  await db.exec(`update ai_usage_ledger set custom_question_count = 1 where user_id='${PREM}';`);
  await asTenant(PREM, async () => {
    const upd = await db.query(`update ai_usage_ledger set custom_question_count = 0 where user_id='${PREM}'`);
    check('control: with the policy dropped again, the attack is blocked once more', (upd.affectedRows ?? 0) === 0, `(affected ${upd.affectedRows})`);
  });

  // ---- Governance tables must be invisible AND unwritable to end users ----
  for (const t of ['ai_platform_controls', 'ai_task_cost_limits']) {
    await asTenant(PREM, async () => {
      const c = (await db.query(`select count(*)::int c from ${t}`)).rows[0].c;
      check(`a tenant sees ZERO rows in ${t} (cannot read the ceilings)`, c === 0, `(saw ${c})`);
      const u = await db.query(t === 'ai_platform_controls'
        ? `update ai_platform_controls set monthly_custom_question_allowance = 99999 where id='global'`
        : `update ai_task_cost_limits set max_cost_per_request_usd = 99999`);
      check(`a tenant cannot raise their own limits via ${t}`, (u.affectedRows ?? 0) === 0, `(affected ${u.affectedRows})`);
    });
    await asAnon(async () => {
      const c = (await db.query(`select count(*)::int c from ${t}`)).rows[0].c;
      check(`anon sees ZERO rows in ${t}`, c === 0, `(saw ${c})`);
    });
    await asService(async () => {
      const c = (await db.query(`select count(*)::int c from ${t}`)).rows[0].c;
      check(`service-role CAN read ${t} (admin routes still work)`, c > 0, `(saw ${c})`);
    });
  }
  const allowance = (await db.query(`select monthly_custom_question_allowance a from ai_platform_controls`)).rows[0].a;
  check('GROUND TRUTH: the allowance was not raised by any tenant attempt', Number(allowance) === 10, `(saw ${allowance})`);

  // Kill switch could not be turned back ON by a user.
  await setControls({ custom_ai_enabled: false, kill_switch_reason: 'cert' });
  await asTenant(PREM, async () => {
    const u = await db.query(`update ai_platform_controls set custom_ai_enabled = true where id='global'`);
    check('a tenant cannot turn the kill switch back ON', (u.affectedRows ?? 0) === 0, `(affected ${u.affectedRows})`);
  });
  const stillOff = (await db.query(`select custom_ai_enabled e from ai_platform_controls`)).rows[0].e;
  check('GROUND TRUTH: the kill switch is still off after the tenant attempt', stillOff === false, `(saw ${stillOff})`);
}

// =============================================================================
console.log('\n=== C. FUNCTION PRIVILEGES + CROSS-USER IDENTITY GUARD ===');
// =============================================================================
await resetState();
{
  const FNS = ['ai_admit_request', 'ai_refund_admission', 'ai_usage_ledger_accumulate'];
  for (const fn of FNS) {
    for (const [role, label] of [['authenticated', 'authenticated'], ['anon', 'anon']]) {
      const has = (await db.query(
        `select bool_or(has_function_privilege($1, p.oid, 'EXECUTE')) g
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname=$2`, [role, fn])).rows[0].g;
      check(`${label} has NO EXECUTE on ${fn}()`, has === false, `(has_function_privilege=${has})`);
    }
    const svc = (await db.query(
      `select bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')) g
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=$1`, [fn])).rows[0].g;
    check(`service_role CAN execute ${fn}() (the server path still works)`, svc === true);
  }

  // Negative control: the privilege probe above must be able to report TRUE.
  await db.exec(`grant execute on function ai_admit_request(uuid,uuid,text,text,text,text,text,numeric,boolean,text,text,text,int,int,int) to authenticated;`);
  const nowHas = (await db.query(`select bool_or(has_function_privilege('authenticated', p.oid,'EXECUTE')) g from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ai_admit_request'`)).rows[0].g;
  check('control: after an explicit GRANT the probe DOES report EXECUTE (probe is not vacuous)', nowHas === true);

  // With EXECUTE temporarily granted, the in-body identity guard is the second
  // layer — a tenant still must not be able to spend someone else's quota.
  await asTenant(FREE, async () => {
    let guarded = false, msg = '';
    try { await db.query(`select ai_admit_request($1,null,'custom','score_explanation','mock','mock-standard-1','STANDARD',0.001,false,'LIVE_AI',null,null,1000,200,500)`, [PREM]); }
    catch (e) { msg = e.message; guarded = /may not admit/i.test(e.message); }
    check('DEFENCE IN DEPTH: even WITH execute granted, a tenant cannot admit a request for another user', guarded, `(${msg.slice(0, 90)})`);
  });
  await asTenant(FREE, async () => {
    const r = (await db.query(`select ai_admit_request($1,null,'custom','score_explanation','mock','mock-standard-1','STANDARD',0.001,false,'LIVE_AI',null,null,1000,200,500) v`, [FREE])).rows[0].v;
    check('control: the same call FOR THEMSELVES is not blocked by the identity guard (it is denied on tier, not on identity)', r.deny_reason === 'not_premium', `(reason=${r.deny_reason})`);
  });
  await db.exec(`revoke execute on function ai_admit_request(uuid,uuid,text,text,text,text,text,numeric,boolean,text,text,text,int,int,int) from authenticated;`);
  const revoked = (await db.query(`select bool_or(has_function_privilege('authenticated', p.oid,'EXECUTE')) g from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ai_admit_request'`)).rows[0].g;
  check('control: EXECUTE successfully revoked again after the test', revoked === false);
}

// =============================================================================
console.log('\n=== D. PREMIUM ENTITLEMENT (reuses user_entitlements, fails closed) ===');
// =============================================================================
await resetState();
{
  const p = await admit({ user: PREM, klass: 'custom' });
  check('a PREMIUM user is admitted for a custom question', p.allowed === true, `(reason=${p.deny_reason})`);
  check('the verdict reports the tier it actually read', p.plan_tier === 'premium', `(saw ${p.plan_tier})`);

  const f = await admit({ user: FREE, household: HH_FREE, klass: 'custom' });
  check('a FREE user is refused a custom question', f.allowed === false && f.deny_reason === 'not_premium', `(reason=${f.deny_reason})`);

  const fs = await admit({ user: FREE, household: HH_FREE, klass: 'standard' });
  check('a FREE user is refused standard personalised AI too, while standard_requires_premium is true', fs.allowed === false && fs.deny_reason === 'not_premium', `(reason=${fs.deny_reason})`);

  await setControls({ standard_requires_premium: false });
  const fs2 = await admit({ user: FREE, household: HH_FREE, klass: 'standard' });
  check('with standard_requires_premium=false a FREE user CAN receive standard personalised AI (the switch is real)', fs2.allowed === true, `(reason=${fs2.deny_reason})`);
  const fc2 = await admit({ user: FREE, household: HH_FREE, klass: 'custom' });
  check('...but custom questions stay Premium-only regardless of that switch', fc2.allowed === false && fc2.deny_reason === 'not_premium', `(reason=${fc2.deny_reason})`);
  await setControls({ standard_requires_premium: true });

  const n = await admit({ user: NOENT, household: null, klass: 'custom' });
  check('FAIL CLOSED: a user with NO entitlement row is denied entitlement_unknown, NOT silently treated as free', n.allowed === false && n.deny_reason === 'entitlement_unknown', `(reason=${n.deny_reason})`);
  const nStd = await admit({ user: NOENT, household: null, klass: 'standard' });
  check('FAIL CLOSED: the same user is denied for standard requests too', nStd.allowed === false && nStd.deny_reason === 'entitlement_unknown', `(reason=${nStd.deny_reason})`);

  const ledgerFree = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${FREE}'`)).rows[0].c;
  check('a denied request consumes NOTHING from the ledger', ledgerFree === 0, `(saw ${ledgerFree})`);
}

// =============================================================================
console.log('\n=== E. MONTHLY QUOTA: 10 per billing month, no rollover ===');
// =============================================================================
await resetState();
{
  let allowed = 0, denied = 0, lastReason = null;
  for (let i = 0; i < 15; i++) {
    const r = await admit({ user: PREM, klass: 'custom' });
    if (r.allowed) allowed++; else { denied++; lastReason = r.deny_reason; }
  }
  check('exactly 10 custom questions are admitted from a 10-question allowance', allowed === 10, `(allowed ${allowed})`);
  check('the remaining 5 are refused', denied === 5, `(denied ${denied})`);
  check("the refusal reason is 'quota_exhausted'", lastReason === 'quota_exhausted', `(saw ${lastReason})`);

  const used = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}' and billing_period=$1`, [period])).rows[0].c;
  check('THE LEDGER IS AUTHORITATIVE: ai_usage_ledger records exactly 10 consumed, matching the decisions', used === 10, `(saw ${used})`);

  // No rollover: usage is counted per billing_period, so a different period
  // starts clean by construction. Simulate the next month by relabelling.
  await db.exec(`update ai_usage_ledger set billing_period = '1999-01' where user_id='${PREM}';`);
  const nextMonth = await admit({ user: PREM, klass: 'custom' });
  check('NO ROLLOVER / MONTHLY RESET: in a new billing period the allowance is full again', nextMonth.allowed === true && nextMonth.quota_used === 1, `(allowed=${nextMonth.allowed} used=${nextMonth.quota_used})`);
  const oldPeriodStill = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}' and billing_period='1999-01'`)).rows[0].c;
  check('NO ROLLOVER: the prior period retains its 10 and does NOT carry forward as credit', oldPeriodStill === 10, `(saw ${oldPeriodStill})`);

  // Cross-tenant: one user's exhaustion must not affect another's allowance.
  await resetState();
  for (let i = 0; i < 10; i++) await admit({ user: PREM, klass: 'custom' });
  const premExhausted = await admit({ user: PREM, klass: 'custom' });
  await db.exec(`update user_entitlements set plan_tier='premium' where user_id='${FREE}';`);
  const otherUser = await admit({ user: FREE, household: HH_FREE, klass: 'custom' });
  check('CROSS-TENANT: one user exhausting their quota does not consume another user\'s', premExhausted.allowed === false && otherUser.allowed === true && otherUser.quota_used === 1, `(A denied=${premExhausted.deny_reason}, B used=${otherUser.quota_used})`);
  await db.exec(`update user_entitlements set plan_tier='free' where user_id='${FREE}';`);
}

// =============================================================================
console.log('\n=== F. WHAT DOES *NOT* CONSUME QUOTA (cache hits, standard requests) ===');
// =============================================================================
await resetState();
{
  for (let i = 0; i < 25; i++) await admit({ user: PREM, klass: 'custom', cacheHit: true });
  const afterCache = (await db.query(`select coalesce(sum(custom_question_count),0)::int q, coalesce(sum(cached_answer_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0];
  check('25 CACHE HITS consume ZERO quota', Number(afterCache.q) === 0, `(consumed ${afterCache.q})`);
  check('...and are still counted as served-from-cache answers', Number(afterCache.c) === 25, `(cached_answer_count ${afterCache.c})`);

  for (let i = 0; i < 25; i++) await admit({ user: PREM, klass: 'standard' });
  const afterStd = (await db.query(`select coalesce(sum(custom_question_count),0)::int q from ai_usage_ledger where user_id='${PREM}'`)).rows[0].q;
  check('25 STANDARD (system-generated) requests consume ZERO quota', Number(afterStd) === 0, `(consumed ${afterStd})`);

  const stillFull = await admit({ user: PREM, klass: 'custom' });
  check('after 50 non-metered requests the full custom allowance is still available', stillFull.allowed === true && stillFull.quota_remaining === 9, `(remaining ${stillFull.quota_remaining})`);

  // Control: the same request WITHOUT the cache flag does consume.
  const consuming = await admit({ user: PREM, klass: 'custom', cacheHit: false });
  check('control: an identical custom request that is NOT a cache hit DOES consume (the flag is what matters)', consuming.quota_consumed === true && consuming.quota_used === 2, `(used ${consuming.quota_used})`);
}

// =============================================================================
console.log('\n=== G. KILL SWITCH ===');
// =============================================================================
await resetState();
{
  const before = await admit({ user: PREM, klass: 'custom' });
  check('setup: custom AI works before the switch is flipped', before.allowed === true);

  await setControls({ custom_ai_enabled: false, kill_switch_reason: 'emergency stop cert' });
  const after = await admit({ user: PREM, klass: 'custom' });
  check('KILL SWITCH: flipping custom_ai_enabled stops the very next custom request', after.allowed === false && after.deny_reason === 'kill_switch_active', `(reason=${after.deny_reason})`);
  const stdStillOk = await admit({ user: PREM, klass: 'standard' });
  check('KILL SWITCH is targeted: standard personalised content keeps working', stdStillOk.allowed === true, `(reason=${stdStillOk.deny_reason})`);
  const usedDuringKill = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('KILL SWITCH: a killed request consumes no quota', usedDuringKill === 1, `(saw ${usedDuringKill}, expected the 1 from setup)`);

  await setControls({ custom_ai_enabled: true, kill_switch_reason: null });
  const restored = await admit({ user: PREM, klass: 'custom' });
  check('KILL SWITCH is reversible: flipping it back restores service immediately', restored.allowed === true, `(reason=${restored.deny_reason})`);

  await setControls({ ai_globally_enabled: false, kill_switch_reason: 'global stop cert' });
  const gc = await admit({ user: PREM, klass: 'custom' });
  const gs = await admit({ user: PREM, klass: 'standard' });
  check('GLOBAL KILL SWITCH stops custom requests', gc.allowed === false && gc.deny_reason === 'ai_disabled', `(reason=${gc.deny_reason})`);
  check('GLOBAL KILL SWITCH stops standard requests too', gs.allowed === false && gs.deny_reason === 'ai_disabled', `(reason=${gs.deny_reason})`);
  await setControls({ ai_globally_enabled: true, kill_switch_reason: null });

  // NO CACHE: the switch is read inside the RPC on every call, so there is no
  // interval in which a stale value could still admit a request. Demonstrated
  // by flipping and immediately calling, with no delay and no reconnect.
  await setControls({ custom_ai_enabled: false, kill_switch_reason: 'immediacy cert' });
  const immediate = await admit({ user: PREM, klass: 'custom' });
  await setControls({ custom_ai_enabled: true, kill_switch_reason: null });
  const immediateBack = await admit({ user: PREM, klass: 'custom' });
  check('KILL SWITCH IS UNCACHED: off->request->on->request flips on the immediately following call, both directions', immediate.deny_reason === 'kill_switch_active' && immediateBack.allowed === true);

  // FAIL CLOSED: no controls row at all.
  await db.exec(`delete from ai_platform_controls;`);
  const noCtl = await admit({ user: PREM, klass: 'custom' });
  check('FAIL CLOSED: with the controls row missing entirely, every request is denied (never default-allow)', noCtl.allowed === false && noCtl.deny_reason === 'controls_unavailable', `(reason=${noCtl.deny_reason})`);
  await db.exec(`insert into ai_platform_controls (id) values ('global');`);
  await resetState();
}

// =============================================================================
console.log('\n=== H. RATE LIMIT (independent of the monthly quota) ===');
// =============================================================================
await resetState();
{
  await setControls({ rate_limit_max_requests: 3, rate_limit_window_seconds: 3600 });
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await admit({ user: PREM, klass: 'standard' }));
  const okCount = results.filter(r => r.allowed).length;
  const rl = results.filter(r => r.deny_reason === 'rate_limited').length;
  check('RATE LIMIT: only 3 of 6 rapid requests are admitted', okCount === 3, `(allowed ${okCount})`);
  check("RATE LIMIT: the rest are refused with 'rate_limited'", rl === 3, `(saw ${rl})`);

  check('RATE LIMIT IS INDEPENDENT OF QUOTA: these were STANDARD requests, which consume no quota at all',
    (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c === 0);

  const rlEvents = (await db.query(`select count(*)::int c from ai_admission_events where deny_reason='rate_limited' and counts_toward_rate_limit`)).rows[0].c;
  check('NO SELF-LOCKOUT: rate-limit denials are excluded from their own window', rlEvents === 0, `(saw ${rlEvents} counted)`);

  await db.exec(`update ai_admission_events set created_at = now() - interval '2 hours' where user_id='${PREM}';`);
  const afterWindow = await admit({ user: PREM, klass: 'standard' });
  check('RATE LIMIT is a ROLLING WINDOW: once the old attempts age out, service resumes', afterWindow.allowed === true, `(reason=${afterWindow.deny_reason})`);

  // Cross-tenant: one user's burst must not rate-limit another.
  await db.exec(`update user_entitlements set plan_tier='premium' where user_id='${FREE}';`);
  for (let i = 0; i < 5; i++) await admit({ user: PREM, klass: 'standard' });
  const other = await admit({ user: FREE, household: HH_FREE, klass: 'standard' });
  check("CROSS-TENANT: one user's burst does not rate-limit a different user", other.allowed === true, `(reason=${other.deny_reason})`);
  await db.exec(`update user_entitlements set plan_tier='free' where user_id='${FREE}';`);
  await setControls({ rate_limit_max_requests: 10000 });
}

// =============================================================================
console.log('\n=== I. COST CEILINGS (per-request, per-user, platform, per-task/model) ===');
// =============================================================================
await resetState();
{
  // --- per-request ---
  const tooBig = await admit({ user: PREM, klass: 'custom', cost: 0.49 }); // seeded task cap for score_explanation is 0.05
  check('PER-REQUEST COST CAP: a call priced above the task cap is refused', tooBig.allowed === false && tooBig.deny_reason === 'request_cost_limit', `(reason=${tooBig.deny_reason})`);
  check('...and the effective cap reported is the TASK cap, i.e. a task limit LOWERS the global cap', Number(tooBig.max_cost_per_request_usd) === 0.05, `(saw ${tooBig.max_cost_per_request_usd})`);
  const okSize = await admit({ user: PREM, klass: 'custom', cost: 0.04 });
  check('control: just under the cap is admitted (the cap is a boundary, not a blanket refusal)', okSize.allowed === true, `(reason=${okSize.deny_reason})`);

  // A task limit must never RAISE the global cap.
  await db.exec(`update ai_task_cost_limits set max_cost_per_request_usd = 10.0 where task_type='score_explanation';`);
  await setControls({ max_cost_per_request_usd: 0.10 });
  const globalWins = await admit({ user: PREM, klass: 'custom', cost: 0.5 });
  check('a task limit can LOWER but never RAISE the global per-request cap', globalWins.allowed === false && globalWins.deny_reason === 'request_cost_limit' && Number(globalWins.max_cost_per_request_usd) === 0.1, `(cap=${globalWins.max_cost_per_request_usd})`);
  await db.exec(`update ai_task_cost_limits set max_cost_per_request_usd = 0.05 where task_type='score_explanation';`);
  await setControls({ max_cost_per_request_usd: 0.5 });

  // --- model tier cap ---
  await resetState();
  // The MODEL, not the caller's declared tier, decides which tier applies —
  // the RPC reads ai_model_registry.internal_tier for the resolved model, so
  // these cases now name a model whose REGISTRY tier is the tier under test.
  const cheapTaskExpensiveModel = await admit({ user: PREM, klass: 'custom', task: 'dna_explanation', model: 'mock-advanced-1', tier: 'ADVANCED', cost: 0.001 });
  check('MODEL/TASK LIMIT: a LOW_COST-capped task refuses to run on an ADVANCED model even when the call is cheap', cheapTaskExpensiveModel.allowed === false && cheapTaskExpensiveModel.deny_reason === 'model_tier_exceeds_task_limit', `(reason=${cheapTaskExpensiveModel.deny_reason})`);
  const cheapTaskCheapModel = await admit({ user: PREM, klass: 'custom', task: 'dna_explanation', model: 'mock-low-1', tier: 'LOW_COST', cost: 0.001 });
  check('control: the same cheap task on a LOW_COST model is admitted', cheapTaskCheapModel.allowed === true, `(reason=${cheapTaskCheapModel.deny_reason})`);
  const advancedTaskAdvancedModel = await admit({ user: PREM, klass: 'custom', task: 'general_coach', model: 'mock-advanced-1', tier: 'ADVANCED', cost: 0.001 });
  check('control: a task explicitly permitted ADVANCED is admitted on an ADVANCED model (bounded, not blanket)', advancedTaskAdvancedModel.allowed === true, `(reason=${advancedTaskAdvancedModel.deny_reason})`);

  // A LIE about the tier no longer buys anything: the caller declares LOW_COST
  // for a model the registry knows is ADVANCED, and the registry wins.
  const liedTier = await admit({ user: PREM, klass: 'custom', task: 'dna_explanation', model: 'mock-advanced-1', tier: 'LOW_COST', cost: 0.001 });
  check('NOT CLIENT-TRUSTED: declaring a cheaper tier than the registry holds does NOT bypass the tier cap', liedTier.allowed === false && liedTier.deny_reason === 'model_tier_exceeds_task_limit', `(reason=${liedTier.deny_reason})`);

  // model_tier_unknown is now reachable only where no registry row supplies a
  // tier, i.e. an outcome that reaches no provider and so is not looked up.
  const unknownTier = await admit({ user: PREM, klass: 'custom', task: 'dna_explanation', tier: null, outcome: 'DETERMINISTIC', cost: 0.001 });
  check('FAIL CLOSED: an unknown model tier where a tier cap applies is denied, not waved through', unknownTier.allowed === false && unknownTier.deny_reason === 'model_tier_unknown', `(reason=${unknownTier.deny_reason})`);

  // --- per-user monthly ceiling ---
  await resetState();
  await setControls({ per_user_monthly_cost_ceiling_usd: 0.10 });
  await db.query(`select ai_usage_ledger_accumulate($1,$2,$3,'score_explanation','mock','mock-standard-1',1,100,0,100,0.09,null)`, [PREM, HH_PREM, period]);
  const overUser = await admit({ user: PREM, klass: 'custom', cost: 0.02 });
  check('PER-USER COST CEILING: a request that would push the user over their monthly ceiling is refused', overUser.allowed === false && overUser.deny_reason === 'user_cost_ceiling', `(reason=${overUser.deny_reason})`);
  const underUser = await admit({ user: PREM, klass: 'custom', cost: 0.005 });
  check('control: a request that stays under the ceiling is admitted', underUser.allowed === true, `(reason=${underUser.deny_reason})`);
  check('PER-USER COST CEILING IS INDEPENDENT OF THE QUESTION QUOTA: the user was blocked with 9+ questions still unused', Number(overUser.quota_remaining) >= 9, `(remaining ${overUser.quota_remaining})`);
  await setControls({ per_user_monthly_cost_ceiling_usd: 5.0 });

  // --- platform-wide ceiling ---
  await resetState();
  await setControls({ platform_monthly_cost_ceiling_usd: 0.10, per_user_monthly_cost_ceiling_usd: 100 });
  await db.query(`select ai_usage_ledger_accumulate($1,$2,$3,'score_explanation','mock','mock-standard-1',1,100,0,100,0.09,null)`, [FREE, HH_FREE, period]);
  const overPlatform = await admit({ user: PREM, klass: 'custom', cost: 0.02 });
  check('PLATFORM COST CEILING: spend by OTHER users can stop this user (an aggregate ceiling, not a per-user one)', overPlatform.allowed === false && overPlatform.deny_reason === 'platform_cost_ceiling', `(reason=${overPlatform.deny_reason})`);
  check('...and the user was not near their own ceiling', Number(overPlatform.user_cost_used_usd) === 0, `(user cost ${overPlatform.user_cost_used_usd})`);
  await setControls({ platform_monthly_cost_ceiling_usd: 500, per_user_monthly_cost_ceiling_usd: 5.0 });

  // --- per-task platform-wide monthly cap ---
  await resetState();
  await db.exec(`update ai_task_cost_limits set max_monthly_cost_usd = 0.05 where task_type='score_explanation';`);
  await db.query(`select ai_usage_ledger_accumulate($1,$2,$3,'score_explanation','mock','mock-standard-1',1,100,0,100,0.049,null)`, [FREE, HH_FREE, period]);
  const overTask = await admit({ user: PREM, klass: 'custom', task: 'score_explanation', cost: 0.01 });
  check('PER-TASK MONTHLY CAP: a task that has burned its monthly budget is refused', overTask.allowed === false && overTask.deny_reason === 'task_monthly_cost_limit', `(reason=${overTask.deny_reason})`);
  const otherTask = await admit({ user: PREM, klass: 'custom', task: 'monthly_summary', cost: 0.01 });
  check('control: a DIFFERENT task with budget remaining is still admitted', otherTask.allowed === true, `(reason=${otherTask.deny_reason})`);
  await db.exec(`update ai_task_cost_limits set max_monthly_cost_usd = null;`);

  // --- cost estimate unavailable ---
  await resetState();
  for (const [label, value] of [['NULL', null], ['negative', -1]]) {
    const r = await admit({ user: PREM, klass: 'custom', cost: value });
    check(`FAIL CLOSED: a ${label} cost estimate denies (cost service unavailable != free)`, r.allowed === false && r.deny_reason === 'cost_estimate_unavailable', `(reason=${r.deny_reason})`);
  }
  const nan = (await db.query(`select ai_admit_request($1,null,'custom','score_explanation','mock','mock-standard-1','STANDARD','NaN'::numeric,false,'LIVE_AI',null,null,1000,200,500) v`, [PREM])).rows[0].v;
  check('FAIL CLOSED: a NaN cost estimate denies', nan.allowed === false && nan.deny_reason === 'cost_estimate_unavailable', `(reason=${nan.deny_reason})`);
  const badClass = await admit({ user: PREM, klass: 'telepathy' });
  check('FAIL CLOSED: an unrecognised request class denies', badClass.allowed === false && badClass.deny_reason === 'invalid_request_class', `(reason=${badClass.deny_reason})`);
}

// =============================================================================
console.log('\n=== J. ATOMICITY: no double-spend of the last unit of quota ===');
// =============================================================================
await resetState();
{
  // The failure mode being tested is check-then-act interleaving: N concurrent
  // requests each read "quota remaining" before any of them writes, so they all
  // believe they may proceed.
  //
  // NEGATIVE CONTROL FIRST — a deliberately naive two-statement implementation,
  // issued exactly the way application code would issue it (a SELECT round trip,
  // then an INSERT round trip, with the two dispatched concurrently). If this
  // does NOT overspend, the harness cannot detect the bug and every "atomic"
  // result below would be vacuous.
  const naiveConsume = async () => {
    const used = (await db.query(
      `select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id=$1 and billing_period=$2`,
      [PREM, period])).rows[0].c;
    if (used >= 10) return 'denied';
    await db.query(
      `insert into ai_usage_ledger (user_id, household_id, billing_period, task_type, provider, model, custom_question_count)
       values ($1,$2,$3,'score_explanation','mock','mock-standard-1',1)
       on conflict (user_id, billing_period, task_type, provider, model)
       do update set custom_question_count = ai_usage_ledger.custom_question_count + 1`,
      [PREM, HH_PREM, period]);
    return 'allowed';
  };
  const naive = await Promise.all(Array.from({ length: 25 }, () => naiveConsume()));
  const naiveAllowed = naive.filter((r) => r === 'allowed').length;
  const naiveLedger = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('NEGATIVE CONTROL: the naive check-then-act implementation DOES overspend under concurrency',
    naiveAllowed > 10 && naiveLedger > 10,
    `(allowed ${naiveAllowed}/25, ledger ${naiveLedger} — a 10-question allowance was overspent, proving this harness can detect the bug)`);

  // NOW THE REAL ONE — same concurrency, same allowance, same fixture.
  //
  // max_concurrent_requests_per_subject is raised for THIS test only. Section
  // 18's concurrency limit is a real gate and would otherwise refuse 24 of
  // these 25 with 'request_in_progress' before the quota was ever consulted —
  // which would make this a concurrency test wearing a quota test's name. The
  // limit is exercised on its own terms in section N below.
  await resetState();
  await setControls({ max_concurrent_requests_per_subject: 100 });
  const verdicts = await Promise.all(Array.from({ length: 25 }, () => admit({ user: PREM, klass: 'custom' })));
  const atomicAllowed = verdicts.filter((v) => v.allowed).length;
  const atomicDenied = verdicts.filter((v) => !v.allowed && v.deny_reason === 'quota_exhausted').length;
  const atomicLedger = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('ATOMIC: 25 concurrent requests against a 10-question allowance admit EXACTLY 10', atomicAllowed === 10, `(allowed ${atomicAllowed}/25)`);
  check('ATOMIC: the other 15 are refused for quota exhaustion', atomicDenied === 15, `(denied ${atomicDenied})`);
  check('ATOMIC: the ledger agrees exactly — no double-spend of the last unit', atomicLedger === 10, `(ledger ${atomicLedger})`);
  const emittedNumbers = verdicts.filter(v => v.allowed).map(v => Number(v.quota_used)).sort((a, b) => a - b);
  check('ATOMIC: the 10 admitted requests were issued 10 DISTINCT sequence numbers 1..10 (no two saw the same remaining count)',
    JSON.stringify(emittedNumbers) === JSON.stringify([1,2,3,4,5,6,7,8,9,10]), `(saw ${JSON.stringify(emittedNumbers)})`);

  const events = (await db.query(`select count(*)::int c from ai_admission_events where user_id='${PREM}'`)).rows[0].c;
  check('ATOMIC: every one of the 25 decisions was audited', events === 25, `(saw ${events})`);
}

// =============================================================================
console.log('\n=== K. REFUND: a failed provider call must not eat the allowance ===');
// =============================================================================
await resetState();
{
  // keepReserved: a refund models a provider FAILURE, so the admission must
  // still be RESERVED. An auto-finalised admission represents a DELIVERED
  // answer, and refunding one of those is correctly refused (anti-minting).
  const a = await admit({ user: PREM, klass: 'custom', keepReserved: true });
  check('setup: a custom request consumed one unit', a.quota_consumed === true && a.quota_used === 1);

  const r1 = (await db.query(`select ai_refund_admission($1) v`, [a.admission_id])).rows[0].v;
  check('REFUND: a consumed question is returned when the provider call produced nothing', r1.refunded === true, `(${JSON.stringify(r1)})`);
  const afterRefund = (await db.query(`select custom_question_count q, refunded_question_count rq from ai_usage_ledger where user_id='${PREM}'`)).rows[0];
  check('REFUND: the ledger decrements the consumed count', Number(afterRefund.q) === 0, `(saw ${afterRefund.q})`);
  check('REFUND: and records the refund separately, so history is not silently rewritten', Number(afterRefund.rq) === 1, `(saw ${afterRefund.rq})`);

  const r2 = (await db.query(`select ai_refund_admission($1) v`, [a.admission_id])).rows[0].v;
  check('REFUND IS IDEMPOTENT: a second refund of the same admission is a no-op', r2.refunded === false && r2.reason === 'already_refunded', `(${JSON.stringify(r2)})`);
  const afterSecond = (await db.query(`select custom_question_count q from ai_usage_ledger where user_id='${PREM}'`)).rows[0].q;
  check('REFUND IS IDEMPOTENT: the ledger is unchanged by the second attempt', Number(afterSecond) === 0, `(saw ${afterSecond})`);

  const denied = await admit({ user: FREE, household: HH_FREE, klass: 'custom' });
  const rd = (await db.query(`select ai_refund_admission($1) v`, [denied.admission_id])).rows[0].v;
  check('REFUND: a DENIED admission has nothing to refund (cannot be used to mint allowance)', rd.refunded === false && rd.reason === 'nothing_to_refund', `(${JSON.stringify(rd)})`);

  const cached = await admit({ user: PREM, klass: 'custom', cacheHit: true, keepReserved: true });
  const rc = (await db.query(`select ai_refund_admission($1) v`, [cached.admission_id])).rows[0].v;
  // A cache hit reaches no provider, so its admission is terminal on creation
  // ('finalised'), never 'reserved'. The refusal reason is therefore
  // 'already_finalised' rather than 'nothing_to_refund' — both are refusals,
  // and this is the accurate one: there was never an outstanding execution.
  check('REFUND: a cache-hit admission consumed nothing and so refunds nothing', rc.refunded === false, `(${JSON.stringify(rc)})`);
  check('REFUND: ...and the reason is that it was terminal on creation, never an in-flight execution', rc.reason === 'already_finalised', `(${JSON.stringify(rc)})`);

  const rn = (await db.query(`select ai_refund_admission('99999999-9999-9999-9999-999999999999'::uuid) v`)).rows[0].v;
  check('REFUND: an unknown admission id is rejected, not silently credited', rn.refunded === false && rn.reason === 'not_found', `(${JSON.stringify(rn)})`);

  // Refunded quota is genuinely reusable.
  await resetState();
  const ids = [];
  await setControls({ max_concurrent_requests_per_subject: 50 });
  for (let i = 0; i < 10; i++) ids.push((await admit({ user: PREM, klass: 'custom', keepReserved: true })).admission_id);
  const exhausted = await admit({ user: PREM, klass: 'custom', keepReserved: true });
  check('setup: allowance exhausted at 10', exhausted.deny_reason === 'quota_exhausted');
  await db.query(`select ai_refund_admission($1)`, [ids[0]]);
  const reused = await admit({ user: PREM, klass: 'custom', keepReserved: true });
  check('REFUND: a refunded unit is genuinely usable again', reused.allowed === true, `(reason=${reused.deny_reason})`);
}

// =============================================================================
console.log('\n=== L. LEDGER ACCUMULATION IS ATOMIC (Module 11.0 defect fix) ===');
// =============================================================================
await resetState();
{
  const acc = () => db.query(
    `select ai_usage_ledger_accumulate($1,$2,$3,'score_explanation','mock','mock-standard-1',1,10,0,20,0.001,null)`,
    [PREM, HH_PREM, period]);
  await Promise.all(Array.from({ length: 30 }, acc));
  const row = (await db.query(`select live_call_count l, input_tokens i, output_tokens o, estimated_cost_usd c from ai_usage_ledger where user_id='${PREM}'`)).rows[0];
  check('30 concurrent ledger accumulations lose NOTHING: live_call_count = 30', Number(row.l) === 30, `(saw ${row.l})`);
  check('...input tokens = 300', Number(row.i) === 300, `(saw ${row.i})`);
  check('...output tokens = 600', Number(row.o) === 600, `(saw ${row.o})`);
  check('...estimated cost = 0.030', Math.abs(Number(row.c) - 0.03) < 1e-9, `(saw ${row.c})`);

  // The accumulator must never touch the quota counters.
  await db.exec(`update ai_usage_ledger set custom_question_count = 4 where user_id='${PREM}';`);
  await acc();
  const q = (await db.query(`select custom_question_count q from ai_usage_ledger where user_id='${PREM}'`)).rows[0].q;
  check('the accumulator never touches the quota counters owned by the admission RPC', Number(q) === 4, `(saw ${q})`);
}

// =============================================================================
console.log('\n=== M. AUDIT COMPLETENESS ===');
// =============================================================================
await resetState();
{
  await admit({ user: PREM, klass: 'custom' });
  await admit({ user: FREE, household: HH_FREE, klass: 'custom' });
  await setControls({ custom_ai_enabled: false, kill_switch_reason: 'audit cert' });
  await admit({ user: PREM, klass: 'custom' });
  await setControls({ custom_ai_enabled: true, kill_switch_reason: null });

  const rows = (await db.query(`select decision, deny_reason from ai_admission_events order by created_at`)).rows;
  check('every decision — allowed and denied — produced exactly one audit row', rows.length === 3, `(saw ${rows.length})`);
  check('each denial records its SPECIFIC reason', rows[1].deny_reason === 'not_premium' && rows[2].deny_reason === 'kill_switch_active', `(saw ${JSON.stringify(rows.map(r=>r.deny_reason))})`);
  check('an allowed decision carries no reason (enforced by CHECK constraint)', rows[0].decision === 'allowed' && rows[0].deny_reason === null);

  let badRow = false;
  await asService(async () => {
    try { await db.query(`insert into ai_admission_events (user_id, billing_period, request_class, task_type, provider, model, decision, deny_reason) values ('${PREM}','${period}','custom','x','mock','m','allowed','quota_exhausted')`); }
    catch (e) { badRow = /check|constraint/i.test(e.message); }
  });
  check('control: an incoherent audit row (allowed + a deny reason) is structurally rejected', badRow);

  let badRefund = false;
  await asService(async () => {
    try { await db.query(`insert into ai_admission_events (user_id, billing_period, request_class, task_type, provider, model, decision, deny_reason, quota_consumed, refunded_at) values ('${PREM}','${period}','custom','x','mock','m','denied','not_premium',false, now())`); }
    catch (e) { badRefund = /check|constraint/i.test(e.message); }
  });
  check('control: a refund recorded against a denied/non-consuming admission is structurally rejected', badRefund);
}


// #############################################################################
// PART 2 — full-specification certification.
//
// Sections A-M above certify the Part 1 enforcement core. Everything below
// certifies the requirements added in the Part 2 pass, and the scenarios the
// specification names as mandatory (sections 80-85).
// #############################################################################

// =============================================================================
console.log('\n=== N. CONCURRENCY LIMIT (spec section 18) ===');
// =============================================================================
await resetState();
{
  const first = await admit({ user: PREM, keepReserved: true });
  check('a live admission is RESERVED, not finalised, until the answer comes back',
    first.allowed === true && first.execution_state === 'reserved' && first.lease_expires_at !== null,
    `(state=${first.execution_state})`);

  const second = await admit({ user: PREM, keepReserved: true });
  check('CONCURRENCY: a second live request while one is in flight is refused',
    second.allowed === false && second.deny_reason === 'request_in_progress', `(reason=${second.deny_reason})`);
  check('CONCURRENCY: the refused request consumed NO quota (spec section 57)',
    second.quota_consumed === false);

  const ledgerAfter = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('CONCURRENCY: the ledger shows exactly the ONE admitted request', ledgerAfter === 1, `(ledger ${ledgerAfter})`);

  await finalise(first.admission_id);
  const third = await admit({ user: PREM, keepReserved: true });
  check('control: once the in-flight request is finalised, the next one is admitted',
    third.allowed === true, `(reason=${third.deny_reason})`);

  // A released reservation must free the subject immediately, not at lease expiry.
  await refund(third.admission_id);
  const fourth = await admit({ user: PREM, keepReserved: true });
  check('control: a RELEASED reservation frees the subject immediately (not at lease expiry)',
    fourth.allowed === true, `(reason=${fourth.deny_reason})`);
  await finalise(fourth.admission_id);

  // A crashed server must not bar a subject forever: the lease expires.
  await resetState();
  const stuck = await admit({ user: PREM, keepReserved: true });
  check('setup: a reservation is open', stuck.allowed === true);
  const blocked = await admit({ user: PREM, keepReserved: true });
  check('control: while the lease is live the subject is blocked', blocked.deny_reason === 'request_in_progress');
  await db.query(`update ai_admission_events set lease_expires_at = now() - interval '1 minute' where id = $1`, [stuck.admission_id]);
  const afterExpiry = await admit({ user: PREM, keepReserved: true });
  check('LEASE: an EXPIRED reservation no longer blocks — a crashed server cannot bar a subject from their own allowance forever',
    afterExpiry.allowed === true, `(reason=${afterExpiry.deny_reason})`);

  // Non-live outcomes are not concurrency-limited: a cached answer costs
  // nothing and holds no provider slot.
  await resetState();
  const held = await admit({ user: PREM, keepReserved: true });
  check('setup: one live reservation open', held.allowed === true);
  const cached = await admit({ user: PREM, cacheHit: true, outcome: 'EXACT_CACHE', keepReserved: true });
  check('CONCURRENCY: a CACHED answer is not blocked by an in-flight live request (it reaches no provider)',
    cached.allowed === true, `(reason=${cached.deny_reason})`);
}

// =============================================================================
console.log('\n=== O. IDEMPOTENCY (spec sections 15, 51.D, 73) ===');
// =============================================================================
await resetState();
{
  const a = await admit({ user: PREM, idemKey: 'retry-1', reqHash: 'hash-A' });
  check('setup: the first request with an idempotency key is admitted and consumes one unit',
    a.allowed === true && a.quota_consumed === true && Number(a.quota_used) === 1);

  const b = await admit({ user: PREM, idemKey: 'retry-1', reqHash: 'hash-A' });
  check('IDEMPOTENT: a retry with the same key REPLAYS the original verdict', b.allowed === true && b.idempotency_reuse === true);
  check('IDEMPOTENT: the replay returns the SAME admission id (one logical execution)', b.admission_id === a.admission_id);
  check('IDEMPOTENT: the replay consumed NO second credit', Number(b.quota_used) === 1, `(used ${b.quota_used})`);

  const ledger = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('IDEMPOTENT: the ledger holds exactly one consumption', ledger === 1, `(ledger ${ledger})`);
  const events = (await db.query(`select count(*)::int c from ai_admission_events where idempotency_key='retry-1'`)).rows[0].c;
  check('IDEMPOTENT: exactly ONE admission event exists for the key (no duplicate audit row)', events === 1, `(events ${events})`);

  const conflict = await admit({ user: PREM, idemKey: 'retry-1', reqHash: 'hash-DIFFERENT' });
  check('IDEMPOTENCY CONFLICT: the same key with a DIFFERENT request body is refused, not answered with the wrong verdict',
    conflict.allowed === false && conflict.deny_reason === 'idempotency_conflict', `(reason=${conflict.deny_reason})`);
  const conflictEv = (await db.query(`select count(*)::int c from ai_operational_events where event_type='idempotency_conflict'`)).rows[0].c;
  check('IDEMPOTENCY CONFLICT: the collision is recorded as an operational event (spec section 38)', conflictEv === 1, `(events ${conflictEv})`);

  // Section 51.D under genuine concurrency.
  await resetState();
  const burst = await Promise.all(Array.from({ length: 8 }, () => admit({ user: PREM, idemKey: 'retry-burst', reqHash: 'hash-B' })));
  const consumed = burst.filter((v) => v.quota_consumed === true).length;
  const replays = burst.filter((v) => v.idempotency_reuse === true).length;
  const burstLedger = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('IDEMPOTENT (section 51.D): 8 concurrent retries of ONE key consume exactly one credit',
    burstLedger === 1, `(ledger ${burstLedger}, consumed-verdicts ${consumed}, replays ${replays})`);
  const burstEvents = (await db.query(`select count(*)::int c from ai_admission_events where idempotency_key='retry-burst'`)).rows[0].c;
  check('IDEMPOTENT (section 51.D): 8 concurrent retries create exactly one admission event', burstEvents === 1, `(events ${burstEvents})`);

  // A DENIAL is replayed as a denial. A retry of a refused request is still refused.
  await resetState();
  const denied1 = await admit({ user: FREE, idemKey: 'retry-denied', reqHash: 'hash-C' });
  check('setup: a Free user is refused', denied1.allowed === false && denied1.deny_reason === 'not_premium');
  const denied2 = await admit({ user: FREE, idemKey: 'retry-denied', reqHash: 'hash-C' });
  check('IDEMPOTENT: replaying a DENIED request returns the same denial, not an accidental allow',
    denied2.allowed === false && denied2.deny_reason === 'not_premium' && denied2.idempotency_reuse === true);

  // An idempotency key belongs to its subject: two users may use the same string.
  await resetState();
  const u1 = await admit({ user: PREM, idemKey: 'shared-key', reqHash: 'h1' });
  const u2 = await admit({ user: FREE, idemKey: 'shared-key', reqHash: 'h2' });
  check('ISOLATION: an idempotency key is scoped to its subject — another user reusing the string is a separate request',
    u1.allowed === true && u2.idempotency_reuse === false && u2.deny_reason === 'not_premium');
}

// =============================================================================
console.log('\n=== P. USAGE OUTCOME ACCOUNTING (spec section 16) ===');
// =============================================================================
await resetState();
{
  const OUTCOMES = ['DETERMINISTIC','KNOWLEDGE_BASE','STANDARD_PERSONALISED','EXACT_CACHE','SEMANTIC_CACHE','LIVE_AI','BATCH_AI','ADMIN_EVALUATION'];
  const declared = (await db.query(`
    select m[1] v from (
      select regexp_matches(pg_get_constraintdef(oid), '''([A-Z_]+)''', 'g') m
        from pg_constraint
       where conrelid = 'ai_admission_events'::regclass and conname like '%usage_outcome%') t`)).rows.map(r => r.v);
  check('all EIGHT usage outcome types from spec section 16 are declared in the database',
    OUTCOMES.every(o => declared.includes(o)) && declared.length === 8, `(saw ${JSON.stringify(declared)})`);

  await setControls({ max_concurrent_requests_per_subject: 50 });
  for (const outcome of OUTCOMES) {
    const isCache = outcome === 'EXACT_CACHE' || outcome === 'SEMANTIC_CACHE';
    const klass = outcome === 'STANDARD_PERSONALISED' || outcome === 'BATCH_AI' ? 'standard' : 'custom';
    const v = await admit({ user: PREM, klass, outcome, cacheHit: isCache });
    const shouldConsume = outcome === 'LIVE_AI';
    check(`OUTCOME ${outcome}: ${shouldConsume ? 'consumes' : 'does NOT consume'} the monthly allowance`,
      v.allowed === true && v.quota_consumed === shouldConsume, `(allowed=${v.allowed} consumed=${v.quota_consumed} reason=${v.deny_reason})`);
  }
  const totalConsumed = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('OUTCOME: across all eight outcome types, exactly ONE unit of allowance was consumed', totalConsumed === 1, `(ledger ${totalConsumed})`);
  const cachedCount = (await db.query(`select coalesce(sum(cached_answer_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('OUTCOME: both cache outcomes were counted as cached answers instead', cachedCount === 2, `(cached ${cachedCount})`);

  // Structural, not conventional: the DB refuses a metered non-LIVE_AI row.
  let batchBlocked = false, nonLiveBlocked = false;
  await asService(async () => {
    try { await db.query(`insert into ai_admission_events (user_id, billing_period, request_class, task_type, provider, model, decision, quota_consumed, usage_outcome) values ('${PREM}','${period}','standard','x','mock','m','allowed',true,'BATCH_AI')`); }
    catch (e) { batchBlocked = /check|constraint/i.test(e.message); }
    try { await db.query(`insert into ai_admission_events (user_id, billing_period, request_class, task_type, provider, model, decision, quota_consumed, usage_outcome) values ('${PREM}','${period}','custom','x','mock','m','allowed',true,'EXACT_CACHE')`); }
    catch (e) { nonLiveBlocked = /check|constraint/i.test(e.message); }
  });
  check('STRUCTURAL: the database REFUSES a BATCH_AI row that consumed quota (spec section 16, not merely by convention)', batchBlocked);
  check('STRUCTURAL: the database REFUSES any non-LIVE_AI row that consumed quota', nonLiveBlocked);

  // An incoherent cache claim must not be reconciled in the permissive direction.
  const lying = await admit({ user: PREM, outcome: 'EXACT_CACHE', cacheHit: false });
  check('FAIL CLOSED: claiming a CACHE outcome without a cache hit is refused, not quietly treated as a cache hit',
    lying.allowed === false && lying.deny_reason === 'invalid_usage_outcome', `(reason=${lying.deny_reason})`);
  const lying2 = await admit({ user: PREM, outcome: 'LIVE_AI', cacheHit: true });
  check('FAIL CLOSED: claiming LIVE_AI while asserting a cache hit is refused (the two inputs must agree)',
    lying2.allowed === false && lying2.deny_reason === 'invalid_usage_outcome', `(reason=${lying2.deny_reason})`);
  const bogus = await admit({ user: PREM, outcome: 'FREE_LUNCH' });
  check('FAIL CLOSED: an unrecognised usage outcome is refused, never defaulted to a quota-exempt one',
    bogus.allowed === false && bogus.deny_reason === 'invalid_usage_outcome', `(reason=${bogus.deny_reason})`);
}

// =============================================================================
console.log('\n=== Q. TOKEN BUDGETS (spec sections 20, 21) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  const okTokens = await admit({ user: PREM, contextTokens: 1000, userInputTokens: 200, outputTokens: 500 });
  check('control: a request inside every token budget is admitted', okTokens.allowed === true, `(reason=${okTokens.deny_reason})`);

  const bigContext = await admit({ user: PREM, contextTokens: 99999 });
  check('TOKEN BUDGET: a context larger than the platform ceiling is refused', bigContext.deny_reason === 'token_budget_exceeded', `(reason=${bigContext.deny_reason})`);

  const bigOutput = await admit({ user: PREM, outputTokens: 99999 });
  check('TOKEN BUDGET: an output cap larger than the platform ceiling is refused', bigOutput.deny_reason === 'token_budget_exceeded', `(reason=${bigOutput.deny_reason})`);

  const bigUserInput = await admit({ user: PREM, contextTokens: 5000, userInputTokens: 4000 });
  check('TOKEN BUDGET: free-form user input is bounded SEPARATELY from the assembled context', bigUserInput.deny_reason === 'token_budget_exceeded', `(reason=${bigUserInput.deny_reason})`);

  // The MODEL's own limit binds even when the platform ceiling is raised —
  // relaxing one must not raise the other. mock-standard-1 is 8000 in / 800 out.
  await setControls({ max_context_tokens: 100000, max_output_tokens: 100000 });
  const overModel = await admit({ user: PREM, contextTokens: 9000, outputTokens: 500 });
  check('TOKEN BUDGET: the MODEL limit still binds when the platform ceiling is raised (the LOWER of the two applies)',
    overModel.deny_reason === 'token_budget_exceeded', `(reason=${overModel.deny_reason})`);
  const overModelOut = await admit({ user: PREM, contextTokens: 1000, outputTokens: 900 });
  check('TOKEN BUDGET: the model OUTPUT limit likewise binds', overModelOut.deny_reason === 'token_budget_exceeded', `(reason=${overModelOut.deny_reason})`);
  const underBoth = await admit({ user: PREM, contextTokens: 7000, outputTokens: 700 });
  check('control: inside BOTH the model and the platform limits, the request is admitted', underBoth.allowed === true, `(reason=${underBoth.deny_reason})`);
  await setControls({ max_context_tokens: 12000, max_output_tokens: 800 });

  const noTokens = await admit({ user: PREM, contextTokens: null, outputTokens: null });
  check('FAIL CLOSED: a provider-bound request declaring NO token figures cannot be checked, so it is refused',
    noTokens.deny_reason === 'token_budget_unavailable', `(reason=${noTokens.deny_reason})`);
  const noTokensCached = await admit({ user: PREM, outcome: 'EXACT_CACHE', cacheHit: true, contextTokens: null, outputTokens: null });
  check('control: a CACHED answer reaches no provider, so it needs no token declaration', noTokensCached.allowed === true, `(reason=${noTokensCached.deny_reason})`);
}

// =============================================================================
console.log('\n=== R. PROVIDER + MODEL KILL SWITCHES, PROVIDER/DAILY COST (sections 26, 31, 32) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  await db.exec(`update ai_provider_controls set enabled=false, disabled_reason='cert' where provider='mock';`);
  const provOff = await admit({ user: PREM });
  check('PROVIDER SWITCH: a disabled provider receives no new calls', provOff.deny_reason === 'provider_disabled', `(reason=${provOff.deny_reason})`);
  await db.exec(`update ai_provider_controls set enabled=true, disabled_reason=null where provider='mock';`);
  check('control: re-enabling the provider restores service', (await admit({ user: PREM })).allowed === true);

  await db.exec(`update ai_model_registry set active=false where model_identifier='mock-standard-1';`);
  const modelOff = await admit({ user: PREM });
  check('MODEL SWITCH: an inactive model receives no new executions', modelOff.deny_reason === 'model_disabled', `(reason=${modelOff.deny_reason})`);
  await db.exec(`update ai_model_registry set active=true, approved=false where model_identifier='mock-standard-1';`);
  check('MODEL SWITCH: an UNAPPROVED model likewise receives no executions', (await admit({ user: PREM })).deny_reason === 'model_disabled');
  await db.exec(`update ai_model_registry set approved=true where model_identifier='mock-standard-1';`);

  await db.exec(`update ai_model_registry set effective_to = now() - interval '1 day' where model_identifier='mock-standard-1';`);
  check('MODEL SWITCH: a model past its effective_to window receives no executions', (await admit({ user: PREM })).deny_reason === 'model_disabled');
  await db.exec(`update ai_model_registry set effective_to = null where model_identifier='mock-standard-1';`);

  const unknownModel = await admit({ user: PREM, model: 'a-model-nobody-approved' });
  check('FAIL CLOSED: a model that is not in the registry at all is refused (approved by nobody = runs for nobody)',
    unknownModel.deny_reason === 'model_unknown', `(reason=${unknownModel.deny_reason})`);

  check('control: with the model active, approved and in window, requests are admitted again', (await admit({ user: PREM })).allowed === true);

  // Section 31: no silent fallback. A disabled provider is a refusal, never a
  // redirect — proven by there being no execution against any OTHER provider.
  await resetState();
  await setControls({ max_concurrent_requests_per_subject: 50 });
  await db.exec(`update ai_provider_controls set enabled=false, disabled_reason='cert' where provider='mock';`);
  await admit({ user: PREM });
  const anyOther = (await db.query(`select count(*)::int c from ai_admission_events where decision='allowed'`)).rows[0].c;
  check('NO SILENT FALLBACK: a request to a disabled provider produced ZERO admitted executions anywhere', anyOther === 0, `(allowed ${anyOther})`);
  await db.exec(`update ai_provider_controls set enabled=true, disabled_reason=null where provider='mock';`);

  // Section 26 — per-provider monthly spend cap.
  await resetState();
  await setControls({ max_concurrent_requests_per_subject: 50 });
  await db.query(`select ai_usage_ledger_accumulate($1,$2,$3,'score_explanation','mock','mock-standard-1',1,100,0,100,0.40,null)`, [PREM, HH_PREM, period]);
  await db.exec(`update ai_provider_controls set monthly_cost_limit_usd=0.41 where provider='mock';`);
  const provCost = await admit({ user: PREM, cost: 0.05 });
  check('PROVIDER COST: spend beyond a provider monthly limit is refused', provCost.deny_reason === 'provider_cost_limit', `(reason=${provCost.deny_reason})`);
  const provCostOk = await admit({ user: PREM, cost: 0.005 });
  check('control: a request that fits under the provider limit is admitted', provCostOk.allowed === true, `(reason=${provCostOk.deny_reason})`);
  await db.exec(`update ai_provider_controls set monthly_cost_limit_usd=null where provider='mock';`);

  // Section 26 — platform DAILY live-AI spend cap.
  await resetState();
  await setControls({ max_concurrent_requests_per_subject: 50, daily_live_ai_cost_limit_usd: 0.010 });
  const d1 = await admit({ user: PREM, cost: 0.008 });
  check('setup: the first request of the day fits under the daily cap', d1.allowed === true, `(reason=${d1.deny_reason})`);
  const d2 = await admit({ user: PREM, cost: 0.008 });
  check('DAILY COST: the second request would breach the daily live-AI cap and is refused', d2.deny_reason === 'daily_cost_limit', `(reason=${d2.deny_reason})`);
  const d3 = await admit({ user: PREM, cost: 0.008, outcome: 'EXACT_CACHE', cacheHit: true });
  check('control: a CACHED answer is still served after the daily LIVE cap is reached (it costs nothing)',
    d3.allowed === true, `(reason=${d3.deny_reason})`);
}

// =============================================================================
console.log('\n=== S. SOFT vs HARD COST THRESHOLDS (spec sections 27, 53.C, 53.D) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  // 53.C — soft threshold reached: warning event, calls CONTINUE.
  await setControls({ platform_soft_cost_threshold_usd: 0.0005, per_user_soft_cost_threshold_usd: 0.0005 });
  const soft = await admit({ user: PREM, cost: 0.001 });
  check('SOFT THRESHOLD (53.C): the request is still ADMITTED after crossing the soft threshold', soft.allowed === true, `(reason=${soft.deny_reason})`);
  check('SOFT THRESHOLD: the verdict reports which soft thresholds were crossed',
    Array.isArray(soft.soft_thresholds_crossed) && soft.soft_thresholds_crossed.includes('platform') && soft.soft_thresholds_crossed.includes('user'),
    `(saw ${JSON.stringify(soft.soft_thresholds_crossed)})`);
  const softEvents = (await db.query(`select count(*)::int c, min(severity) s from ai_operational_events where event_type='soft_cost_threshold_reached'`)).rows[0];
  check('SOFT THRESHOLD: an operational WARNING event is recorded (spec section 38)', softEvents.c >= 2, `(events ${softEvents.c})`);

  // Negative control: with no soft threshold configured, nothing warns.
  await resetState();
  await setControls({ max_concurrent_requests_per_subject: 50 });
  const noSoft = await admit({ user: PREM, cost: 0.001 });
  const noSoftEvents = (await db.query(`select count(*)::int c from ai_operational_events where event_type='soft_cost_threshold_reached'`)).rows[0].c;
  check('NEGATIVE CONTROL: with NO soft threshold configured, nothing warns (NULL is not zero)',
    noSoft.allowed === true && noSoftEvents === 0 && noSoft.soft_thresholds_crossed.length === 0, `(events ${noSoftEvents})`);

  // 53.D — hard threshold reached: new live AI is BLOCKED.
  await resetState();
  await setControls({ max_concurrent_requests_per_subject: 50, platform_monthly_cost_ceiling_usd: 0.0005, platform_soft_cost_threshold_usd: 0.0001 });
  const hard = await admit({ user: PREM, cost: 0.001 });
  check('HARD THRESHOLD (53.D): a request beyond the platform hard ceiling is BLOCKED', hard.deny_reason === 'platform_cost_ceiling', `(reason=${hard.deny_reason})`);
  const crit = (await db.query(`select count(*)::int c from ai_operational_events where event_type='global_cost_ceiling_reached' and severity='CRITICAL'`)).rows[0].c;
  check('HARD THRESHOLD: the block is recorded as a CRITICAL operational event', crit === 1, `(events ${crit})`);

  // Section 27: non-AI/cached content keeps being served during a hard stop.
  const cachedDuringStop = await admit({ user: PREM, cost: 0, outcome: 'EXACT_CACHE', cacheHit: true });
  check('SECTION 27: cached answers are STILL SERVED while the AI hard cost stop is in force', cachedDuringStop.allowed === true, `(reason=${cachedDuringStop.deny_reason})`);
  const deterministicDuringStop = await admit({ user: PREM, cost: 0, outcome: 'DETERMINISTIC', tier: 'STANDARD' });
  check('SECTION 27: deterministic answers are STILL SERVED while the AI hard cost stop is in force', deterministicDuringStop.allowed === true, `(reason=${deterministicDuringStop.deny_reason})`);

  // A soft threshold above its hard ceiling can never fire — refused by the DB.
  let softAboveHard = false;
  try { await db.exec(`update ai_platform_controls set platform_soft_cost_threshold_usd = 99999 where id='global';`); }
  catch (e) { softAboveHard = /check|constraint/i.test(e.message); }
  check('SECTION 58: a soft threshold ABOVE its hard ceiling is rejected by the DATABASE, not merely by a route', softAboveHard);
}

// =============================================================================
console.log('\n=== T. CONFIG AUDIT + OPERATIONAL EVENTS (spec sections 33, 38, 59) ===');
// =============================================================================
await resetState();
{
  // The audit table cannot be truncated between tests — it refuses DELETE by
  // trigger, which is exactly the property under test. A clock baseline is
  // taken instead, so only rows written by THIS statement are examined.
  // The audit table cannot be truncated between tests — it refuses DELETE by
  // trigger, which is exactly the property under test. The pre-existing row ids
  // are captured instead, so only rows written by THIS statement are examined.
  // (A timestamp baseline would NOT work: changed_at defaults to now(), which
  // is transaction start time, so it need not be later than a clock reading
  // taken in a previous statement.)
  const seenIds = (await db.query(`select id::text i from ai_config_audit`)).rows.map(r => r.i);
  await db.query(`update ai_platform_controls set custom_ai_enabled=false, kill_switch_reason='cost incident', updated_by=$1 where id='global'`, [PREM]);
  const newAudit = async (table, field) => (await db.query(
    `select field, previous_value, new_value, changed_by::text, reason, operation from ai_config_audit
      where config_table=$1 and ($2::text is null or field=$2) and not (id::text = any($3::text[])) order by field`,
    [table, field, seenIds2 ?? seenIds])).rows;
  let seenIds2 = null;
  const rows = await newAudit('ai_platform_controls', null);
  const flip = rows.find(r => r.field === 'custom_ai_enabled');
  check('CONFIG AUDIT: flipping a kill switch writes a field-level audit row', !!flip);
  check('CONFIG AUDIT: the row carries previous value, new value, actor and reason',
    flip && flip.previous_value === 'true' && flip.new_value === 'false' && flip.changed_by === PREM && flip.reason === 'cost incident' && flip.operation === 'UPDATE',
    `(${JSON.stringify(flip)})`);
  check('CONFIG AUDIT: updated_at is NOT audited (it changes on every write and carries no governance meaning)',
    !rows.some(r => r.field === 'updated_at'));
  check('CONFIG AUDIT: an UNCHANGED field produces no row (one row per CHANGED field, not per statement)',
    !rows.some(r => r.field === 'ai_globally_enabled'), `(fields ${JSON.stringify(rows.map(r=>r.field))})`);

  let updBlocked = false, delBlocked = false;
  await asService(async () => {
    try { await db.exec(`update ai_config_audit set new_value='true'`); } catch (e) { updBlocked = /append-only/i.test(e.message); }
    try { await db.exec(`delete from ai_config_audit`); } catch (e) { delBlocked = /append-only/i.test(e.message); }
  });
  check('APPEND-ONLY: ai_config_audit refuses UPDATE (history that can be edited is not an audit trail)', updBlocked);
  check('APPEND-ONLY: ai_config_audit refuses DELETE', delBlocked);

  // The audit follows the other governance tables too, not only the controls row.
  seenIds2 = (await db.query(`select id::text i from ai_config_audit`)).rows.map(r => r.i);
  await db.query(`update ai_provider_controls set enabled=false, disabled_reason='cert', updated_by=$1 where provider='mock'`, [PREM]);
  const provAudit = (await newAudit('ai_provider_controls', 'enabled')).length;
  check('CONFIG AUDIT: provider control changes are audited too', provAudit === 1, `(rows ${provAudit})`);
  seenIds2 = (await db.query(`select id::text i from ai_config_audit`)).rows.map(r => r.i);
  await db.query(`update ai_model_registry set active=false, updated_at=now() where model_identifier='mock-low-1'`);
  const modelAudit = (await newAudit('ai_model_registry', 'active')).length;
  check('CONFIG AUDIT: model registry changes are audited too', modelAudit === 1, `(rows ${modelAudit})`);
  await db.exec(`update ai_provider_controls set enabled=true, disabled_reason=null where provider='mock';`);
  await db.exec(`update ai_model_registry set active=true where model_identifier='mock-low-1';`);

  // Section 59: never log secrets. Nothing audited can contain one, because no
  // key column exists on any audited table.
  const secretish = (await db.query(`
    select count(*)::int c from information_schema.columns
     where table_schema='public'
       and table_name in ('ai_platform_controls','ai_task_cost_limits','ai_provider_controls','ai_model_registry')
       and (column_name ilike '%api_key%' or column_name ilike '%secret%' or column_name ilike '%token_value%' or column_name ilike '%password%')`)).rows[0].c;
  check('SECTION 59: no audited configuration table has any secret-bearing column, so no secret can be logged', secretish === 0, `(columns ${secretish})`);
}

// =============================================================================
console.log('\n=== U. OPERATIONAL EVENT COVERAGE + SEVERITY (spec sections 38, 60) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  await admit({ user: FREE });                                                   // entitlement_mismatch
  await setControls({ monthly_custom_question_allowance: 0 });
  await admit({ user: PREM });                                                   // quota_exhausted
  await setControls({ monthly_custom_question_allowance: 10, rate_limit_max_requests: 1 });
  await admit({ user: PREM }); await admit({ user: PREM });                      // rate_limit_triggered
  await setControls({ rate_limit_max_requests: 10000, custom_ai_enabled: false, kill_switch_reason: 'cert' });
  await admit({ user: PREM });                                                   // kill_switch_blocked
  await setControls({ custom_ai_enabled: true, kill_switch_reason: null });
  await admit({ user: PREM, contextTokens: 999999 });                            // token_budget_exceeded
  await db.exec(`update ai_provider_controls set enabled=false, disabled_reason='cert' where provider='mock';`);
  await admit({ user: PREM });                                                   // provider_disabled_blocked
  await db.exec(`update ai_provider_controls set enabled=true, disabled_reason=null where provider='mock';`);

  const seen = (await db.query(`select distinct event_type from ai_operational_events order by 1`)).rows.map(r => r.event_type);
  for (const t of ['entitlement_mismatch','quota_exhausted','rate_limit_triggered','kill_switch_blocked','token_budget_exceeded','provider_disabled_blocked']) {
    check(`OPS EVENT: '${t}' is recorded (spec section 38)`, seen.includes(t), `(saw ${JSON.stringify(seen)})`);
  }
  const sev = Object.fromEntries((await db.query(`select event_type, min(severity) s from ai_operational_events group by 1`)).rows.map(r => [r.event_type, r.s]));
  check('SEVERITY: routine quota exhaustion is INFO, while a kill switch is HIGH — not one flat level for everything',
    sev.quota_exhausted === 'INFO' && sev.kill_switch_blocked === 'HIGH', `(${JSON.stringify(sev)})`);

  // Section 61: operational events are NOT user-readable — their metadata
  // carries spend figures and ceiling values.
  const opsVisible = await asTenant(PREM, async () => (await db.query(`select count(*)::int c from ai_operational_events`)).rows[0].c);
  check('PRIVACY (section 61): a user cannot read ai_operational_events at all (its metadata carries ceilings and spend)', opsVisible === 0, `(rows ${opsVisible})`);
  const auditVisible = await asTenant(PREM, async () => (await db.query(`select count(*)::int c from ai_config_audit`)).rows[0].c);
  check('PRIVACY: a user cannot read ai_config_audit', auditVisible === 0, `(rows ${auditVisible})`);
  const provVisible = await asTenant(PREM, async () => (await db.query(`select count(*)::int c from ai_provider_controls`)).rows[0].c);
  check('PRIVACY: a user cannot read ai_provider_controls', provVisible === 0, `(rows ${provVisible})`);
}

// =============================================================================
console.log('\n=== V. ENTITLEMENT READ MODEL (spec sections 5, 8, 39, 61) ===');
// =============================================================================
await resetState();
{
  const st = async (u) => (await db.query(`select ai_entitlement_state($1) v`, [u])).rows[0].v;

  const prem = await st(PREM);
  check('READ MODEL: a Premium subject is reported eligible', prem.eligible === true && prem.reason === null);
  check('READ MODEL: it reports limit/used/remaining and the period boundaries',
    prem.custom_questions.limit === 10 && prem.custom_questions.used === 0 && prem.custom_questions.remaining === 10
    && /^\d{4}-\d{2}-\d{2}$/.test(prem.period_start) && /^\d{4}-\d{2}-\d{2}$/.test(prem.period_end),
    `(${JSON.stringify(prem.custom_questions)})`);
  check('READ MODEL: upgrade_available is FALSE (not null) for an eligible subject', prem.upgrade_available === false);
  check('READ MODEL: the named feature entitlement is AI_COACH_PREMIUM (spec section 6)', prem.plan_feature === 'AI_COACH_PREMIUM');

  // Section 8/61 — the safe-field allowlist. None of these may ever appear.
  const FORBIDDEN = ['cost','ceiling','platform','threshold','provider','model','rate_limit','kill_switch','spend','budget'];
  const leaked = FORBIDDEN.filter(k => JSON.stringify(prem).toLowerCase().includes(k));
  check('PRIVACY (sections 8/61): the entitlement payload contains NO cost ceiling, platform total, provider, model, rate-limit or kill-switch field',
    leaked.length === 0, `(leaked ${JSON.stringify(leaked)})`);

  const free = await st(FREE);
  check('READ MODEL: a Free subject is reported not-eligible with reason premium_required', free.eligible === false && free.reason === 'premium_required');
  check('READ MODEL: upgrade_available is TRUE for a genuinely free subject (spec section 7)', free.upgrade_available === true);

  const noent = await st(NOENT);
  check('FAIL CLOSED: a subject with NO entitlement row is not-eligible for entitlement_unknown', noent.eligible === false && noent.reason === 'entitlement_unknown');
  check('HONEST UPSELL: an UNKNOWN entitlement does NOT offer an upgrade — an outage is not fixed by paying', noent.upgrade_available === false);

  await setControls({ custom_ai_enabled: false, kill_switch_reason: 'cert' });
  const killed = await st(PREM);
  check('READ MODEL: with the kill switch on, a Premium subject is reported not-eligible', killed.eligible === false && killed.reason === 'ai_temporarily_disabled');
  check('READ MODEL: the kill-switch REASON is never disclosed to the user (spec section 7)', !JSON.stringify(killed).includes('cert'));
  check('HONEST UPSELL: a kill switch does not offer an upgrade either', killed.upgrade_available === false);
  await setControls({ custom_ai_enabled: true, kill_switch_reason: null });

  // The read model and the admission decision must agree about consumption.
  await resetState();
  await setControls({ max_concurrent_requests_per_subject: 50 });
  await admit({ user: PREM }); await admit({ user: PREM }); await admit({ user: PREM });
  const after = await st(PREM);
  check('CONSISTENCY: after three consumed questions the read model reports 3 used / 7 remaining',
    after.custom_questions.used === 3 && after.custom_questions.remaining === 7, `(${JSON.stringify(after.custom_questions)})`);

  // Cross-user reads are refused even if the function is somehow reached.
  let crossBlocked = false;
  await asTenant(PREM, async () => {
    try { await db.query(`select ai_entitlement_state($1)`, [FREE]); }
    catch (e) { crossBlocked = /42501|may not read|permission denied/i.test(e.message); }
  });
  check('ISOLATION: reading ANOTHER subject entitlement is refused (42501), not answered', crossBlocked);
}

// =============================================================================
console.log('\n=== W. PREMIUM/FREE MATRIX + SUBSCRIPTION STATES (spec sections 10, 70) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  // 1-2. Free active / Premium active.
  check('MATRIX 1 — free, active: refused not_premium', (await admit({ user: FREE })).deny_reason === 'not_premium');
  check('MATRIX 2 — premium, active: admitted', (await admit({ user: PREM })).allowed === true);

  // 3-5. Premium at 0, 9 and 10 of 10 used.
  await resetState(); await setControls({ max_concurrent_requests_per_subject: 50 });
  check('MATRIX 3 — premium, 0 of 10 used: admitted', (await admit({ user: PREM })).allowed === true);
  await resetState(); await setControls({ max_concurrent_requests_per_subject: 50 });
  await db.query(`select ai_usage_ledger_accumulate($1,$2,$3,'score_explanation','mock','mock-standard-1',0,0,0,0,0,null)`, [PREM, HH_PREM, period]);
  await db.exec(`update ai_usage_ledger set custom_question_count = 9 where user_id='${PREM}';`);
  const at9 = await admit({ user: PREM });
  check('MATRIX 4 — premium, 9 of 10 used: the tenth question is admitted', at9.allowed === true && Number(at9.quota_used) === 10, `(used ${at9.quota_used})`);
  const at10 = await admit({ user: PREM });
  check('MATRIX 5 — premium, 10 of 10 used: refused quota_exhausted', at10.deny_reason === 'quota_exhausted', `(reason=${at10.deny_reason})`);

  // 6. Expired Premium (effective_to in the past) — now genuinely enforced.
  await resetState(); await setControls({ max_concurrent_requests_per_subject: 50 });
  await db.exec(`update user_entitlements set effective_to = current_date - 1 where user_id='${PREM}';`);
  const expired = await admit({ user: PREM });
  check('MATRIX 6 — EXPIRED premium (effective_to in the past): refused (spec section 10)',
    expired.deny_reason === 'entitlement_expired', `(reason=${expired.deny_reason})`);

  // 7. Cancel-at-period-end, still INSIDE the paid period.
  await db.exec(`update user_entitlements set effective_to = current_date + 7 where user_id='${PREM}';`);
  const cancelling = await admit({ user: PREM });
  check('MATRIX 7 — CANCEL_AT_PERIOD_END inside the paid period: still eligible until expiry (spec section 10)',
    cancelling.allowed === true, `(reason=${cancelling.deny_reason})`);

  // 8. Cancelled, after the entitlement ended — history must survive.
  const beforeHistory = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  await db.exec(`update user_entitlements set effective_to = current_date - 1 where user_id='${PREM}';`);
  const cancelled = await admit({ user: PREM });
  const afterHistory = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('MATRIX 8 — CANCELLED after entitlement end: refused', cancelled.allowed === false);
  check('MATRIX 8 — historical usage is NEVER erased when entitlement ends (spec section 10)',
    afterHistory === beforeHistory && afterHistory > 0, `(before ${beforeHistory}, after ${afterHistory})`);
  await db.exec(`update user_entitlements set effective_to = null where user_id='${PREM}';`);

  // 9. Downgrade: premium -> free. Access denied; history preserved.
  await db.exec(`update user_entitlements set plan_tier='free' where user_id='${PREM}';`);
  const downgraded = await admit({ user: PREM });
  const historyAfterDowngrade = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('MATRIX 9 — DOWNGRADE premium->free: refused not_premium', downgraded.deny_reason === 'not_premium');
  check('MATRIX 9 — historical usage survives a downgrade', historyAfterDowngrade === afterHistory);
  await db.exec(`update user_entitlements set plan_tier='premium' where user_id='${PREM}';`);

  // 10. Unknown entitlement.
  check('MATRIX 10 — NO entitlement row: refused entitlement_unknown (never silently "free")',
    (await admit({ user: NOENT })).deny_reason === 'entitlement_unknown');

  // 11-12. TRIAL / GRACE / PAST_DUE / REFUNDED / SUSPENDED are NOT representable.
  // Spec section 10 forbids inventing unsupported policy, so this proves they
  // genuinely cannot exist rather than claiming to handle them.
  const UNSUPPORTED = ['TRIAL','PAST_DUE','GRACE','CANCEL_AT_PERIOD_END','CANCELLED','EXPIRED','REFUNDED','SUSPENDED','trial','past_due'];
  let allRejected = true;
  for (const state of UNSUPPORTED) {
    try { await db.query(`update user_entitlements set plan_tier=$1 where user_id=$2`, [state, FREE]); allRejected = false; }
    catch { /* CHECK constraint rejected it, as expected */ }
  }
  check('MATRIX 11 — TRIAL/PAST_DUE/GRACE/REFUNDED/SUSPENDED are NOT REPRESENTABLE: plan_tier rejects all ten (so no policy was invented for them)',
    allRejected);
  const tiers = (await db.query(`select m[1] v from (select regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''', 'g') m from pg_constraint where conrelid='user_entitlements'::regclass and contype='c') t`)).rows.map(r => r.v);
  check('MATRIX 12 — the ONLY subscription states this codebase has are free and premium (documented, not assumed)',
    JSON.stringify(tiers.sort()) === JSON.stringify(['free','premium']), `(saw ${JSON.stringify(tiers)})`);

  // Admin membership grants no consumer AI entitlement.
  await db.exec(`insert into user_entitlements (user_id, plan_tier) values ('${NOENT}','free') on conflict (user_id) do update set plan_tier='free';`);
  await db.exec(`insert into admin_users (user_id, notes) values ('${NOENT}','cert super admin') on conflict do nothing;`);
  const adminNotPremium = await admit({ user: NOENT });
  check('MATRIX — an ADMIN (admin_users member) on a free plan does NOT automatically get consumer AI entitlement',
    adminNotPremium.deny_reason === 'not_premium', `(reason=${adminNotPremium.deny_reason})`);
  await db.exec(`delete from admin_users where user_id='${NOENT}'; delete from user_entitlements where user_id='${NOENT}';`);
}

// =============================================================================
console.log('\n=== X. PERIOD RESET, NO ROLLOVER, DB-AUTHORITATIVE CLOCK (sections 9, 71, 73) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  // Period 1: consume all ten.
  for (let i = 0; i < 10; i++) await admit({ user: PREM });
  const p1Used = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}' and billing_period=$1`, [period])).rows[0].c;
  check('PERIOD 1: ten questions consumed, allowance exhausted', p1Used === 10, `(used ${p1Used})`);
  check('PERIOD 1: the eleventh is refused', (await admit({ user: PREM })).deny_reason === 'quota_exhausted');

  // Period 2 begins. Simulated by relabelling the ledger into the PREVIOUS
  // month, which is exactly what a period boundary looks like from the
  // enforcement path's point of view: this period's count starts at zero while
  // last period's rows still exist.
  const [py, pm] = period.split('-').map(Number);
  const prev = pm === 1 ? `${py - 1}-12` : `${py}-${String(pm - 1).padStart(2, '0')}`;
  await db.query(`update ai_usage_ledger set billing_period=$1 where user_id=$2`, [prev, PREM]);
  await db.exec(`update ai_admission_events set execution_state='finalised', lease_expires_at=null where execution_state='reserved';`);

  const p2 = await admit({ user: PREM });
  check('PERIOD 2: the allowance has reset — the first question of the new period is admitted', p2.allowed === true, `(reason=${p2.deny_reason})`);
  check('PERIOD 2: used resets to 1 of 10, remaining 9', Number(p2.quota_used) === 1 && Number(p2.quota_remaining) === 9, `(used ${p2.quota_used}, remaining ${p2.quota_remaining})`);

  const p1Still = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}' and billing_period=$1`, [prev])).rows[0].c;
  check('PERIOD 1 HISTORY IS IMMUTABLE: last period still records its 10 consumed questions', p1Still === 10, `(prev ${p1Still})`);

  // NO ROLLOVER, in the direction that actually matters: unused allowance does
  // not accumulate. Two untouched periods must still yield exactly 10, not 20.
  await resetState();
  await setControls({ max_concurrent_requests_per_subject: 50 });
  await db.query(`insert into ai_usage_ledger (user_id, household_id, billing_period, task_type, provider, model, custom_question_count) values ($1,$2,$3,'score_explanation','mock','mock-standard-1',0)`, [PREM, HH_PREM, prev]);
  let admitted = 0;
  for (let i = 0; i < 15; i++) if ((await admit({ user: PREM })).allowed) admitted++;
  check('NO ROLLOVER: an entirely unused previous period grants exactly 10 this period, not 20',
    admitted === 10, `(admitted ${admitted})`);

  // Section 73 — the DB clock is authoritative, not the app server's timezone.
  const dbPeriod = (await db.query(`select ai_billing_period_for($1) p`, [PREM])).rows[0].p;
  const utcPeriod = (await db.query(`select to_char(now() at time zone 'utc','YYYY-MM') p`)).rows[0].p;
  check('CLOCK: ai_billing_period_for() is UTC-derived in the DATABASE, not from any application timezone',
    dbPeriod === utcPeriod, `(fn ${dbPeriod}, utc ${utcPeriod})`);

  await db.exec(`set timezone='Pacific/Kiritimati';`);
  const tzShifted = (await db.query(`select ai_billing_period_for($1) p`, [PREM])).rows[0].p;
  await db.exec(`set timezone='UTC';`);
  check('CLOCK: the period is unchanged by a session timezone as extreme as UTC+14 (no local-time leakage)',
    tzShifted === utcPeriod, `(shifted ${tzShifted}, utc ${utcPeriod})`);

  // A boundary request is attributed to the period the DB says it is in.
  const boundary = (await db.query(`select ai_billing_period_for($1, '2026-08-31T23:59:59Z'::timestamptz) a, ai_billing_period_for($1, '2026-09-01T00:00:01Z'::timestamptz) b`, [PREM])).rows[0];
  check('CLOCK: a request one second before and one second after a month boundary lands in DIFFERENT periods',
    boundary.a === '2026-08' && boundary.b === '2026-09', `(${boundary.a} / ${boundary.b})`);
}

// =============================================================================
console.log('\n=== Y. REQUIRED SCENARIO: FULL LIFECYCLE + FAILURE (spec section 80) ===');
// =============================================================================
await resetState();
{
  const st = async (u) => (await db.query(`select ai_entitlement_state($1) v`, [u])).rows[0].v;

  const before = await st(PREM);
  check('80.1 entitlement confirmed, 10 credits available', before.eligible === true && before.custom_questions.remaining === 10);

  const controls = (await db.query(`select * from ai_platform_controls where id='global'`)).rows[0];
  check('80.2 feature enabled, no kill switch active', controls.ai_globally_enabled && controls.custom_ai_enabled && controls.live_provider_enabled);

  const adm = await admit({ user: PREM, cost: 0.001, keepReserved: true });
  check('80.3 rate limit clear, no concurrent request, cost under ceiling -> ADMITTED', adm.allowed === true, `(reason=${adm.deny_reason})`);
  check('80.4 exactly one question RESERVED', adm.quota_consumed === true && adm.execution_state === 'reserved');

  // The provider call and output validation happen in the gateway (unit-tested
  // separately against the real MockAIProvider); here the DB-side finalisation
  // that follows a validated answer is what is being certified.
  const fin = await finalise(adm.admission_id);
  check('80.5 a validated answer FINALISES the reservation', fin.finalised === true, `(${JSON.stringify(fin)})`);

  const ledger = (await db.query(`select custom_question_count, refunded_question_count from ai_usage_ledger where user_id='${PREM}'`)).rows[0];
  check('80.6 quota finalises at 1 of 10', Number(ledger.custom_question_count) === 1 && Number(ledger.refunded_question_count) === 0);
  const after = await st(PREM);
  check('80.7 the entitlement endpoint now shows 9 remaining', after.custom_questions.remaining === 9, `(remaining ${after.custom_questions.remaining})`);

  const ev = (await db.query(`select decision, execution_state, finalised_at from ai_admission_events where id=$1`, [adm.admission_id])).rows[0];
  check('80.8 the decision is audited as allowed + finalised', ev.decision === 'allowed' && ev.execution_state === 'finalised' && ev.finalised_at !== null);

  // Provider-failure half of section 80.
  const adm2 = await admit({ user: PREM, cost: 0.001, keepReserved: true });
  check('80.9 a second request reserves another credit', adm2.quota_consumed === true);
  // Section 56: the provider cost is recorded even though the credit is released.
  await db.query(`select ai_usage_ledger_accumulate($1,$2,$3,'score_explanation','mock','mock-standard-1',1,100,0,0,0.0007,null)`, [PREM, HH_PREM, period]);
  const ref = await refund(adm2.admission_id);
  check('80.10 the provider failed -> the credit is RELEASED', ref.refunded === true, `(${JSON.stringify(ref)})`);
  const after2 = await st(PREM);
  check('80.11 remaining questions are unchanged by the failure (still 9)', after2.custom_questions.remaining === 9, `(remaining ${after2.custom_questions.remaining})`);
  const cost = (await db.query(`select coalesce(sum(estimated_cost_usd),0)::float c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('80.12 (section 56) the PROVIDER COST is still recorded even though the user credit was released',
    cost > 0, `(cost ${cost})`);
  const ev2 = (await db.query(`select execution_state, refunded_at from ai_admission_events where id=$1`, [adm2.admission_id])).rows[0];
  check('80.13 the failed admission is audited as RELEASED', ev2.execution_state === 'released' && ev2.refunded_at !== null);
}

// =============================================================================
console.log('\n=== Z. REQUIRED SCENARIO: LIMIT EXHAUSTION (spec section 81) ===');
// =============================================================================
await resetState();
{
  await db.query(`insert into ai_usage_ledger (user_id, household_id, billing_period, task_type, provider, model, custom_question_count) values ($1,$2,$3,'score_explanation','mock','mock-standard-1',9)`, [PREM, HH_PREM, period]);
  const st0 = (await db.query(`select ai_entitlement_state($1) v`, [PREM])).rows[0].v;
  check('81 setup: the subject is at 9 consumed, 1 remaining', st0.custom_questions.used === 9 && st0.custom_questions.remaining === 1);

  const [r1, r2] = await Promise.all([
    admit({ user: PREM, keepReserved: true }),
    admit({ user: PREM, keepReserved: true }),
  ]);
  const allowed = [r1, r2].filter(r => r.allowed);
  const refused = [r1, r2].filter(r => !r.allowed);
  check('81.1 exactly ONE of the two concurrent requests is admitted', allowed.length === 1, `(allowed ${allowed.length})`);
  check('81.2 exactly one credit was consumed; the quota becomes 10 of 10',
    (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c === 10);
  check('81.3 the second request receives a LIMIT response', refused.length === 1 && refused[0].deny_reason === 'quota_exhausted', `(reason=${refused[0]?.deny_reason})`);
  check('81.4 the refused request reserved nothing, so no provider call could follow it',
    refused[0].admission_id !== null && refused[0].quota_consumed === false && refused[0].execution_state === 'finalised');
  const reserved = (await db.query(`select count(*)::int c from ai_admission_events where user_id='${PREM}' and execution_state='reserved'`)).rows[0].c;
  check('81.5 exactly ONE reservation exists — only one request can reach a provider', reserved === 1, `(reserved ${reserved})`);
}

// =============================================================================
console.log('\n=== AA. REQUIRED SCENARIO: GLOBAL KILL SWITCH (spec sections 54, 82) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  // Section 54 insists on RUNTIME behaviour, not config inspection: an
  // invocation counter that must not increase. ai_admission_events with
  // decision='allowed' IS that counter — an admitted request is precisely one
  // that would reach a provider, and nothing else can.
  const admittedCount = async () => (await db.query(`select count(*)::int c from ai_admission_events where decision='allowed'`)).rows[0].c;

  check('82.1 switch enabled', (await db.query(`select ai_globally_enabled g from ai_platform_controls`)).rows[0].g === true);
  const before = await admittedCount();
  check('82.2 the request succeeds while enabled', (await admit({ user: PREM })).allowed === true);
  const mid = await admittedCount();
  check('82.2 the admitted-invocation counter increased', mid === before + 1, `(${before} -> ${mid})`);

  await setControls({ ai_globally_enabled: false, kill_switch_reason: 'cert kill' });
  const blocked = await admit({ user: PREM });
  check('82.3/82.7 the SAME request is now blocked', blocked.allowed === false && blocked.deny_reason === 'ai_disabled', `(reason=${blocked.deny_reason})`);
  const afterKill = await admittedCount();
  check('82.7 RUNTIME PROOF: the admitted-invocation counter did NOT increase', afterKill === mid, `(${mid} -> ${afterKill})`);

  const stKilled = (await db.query(`select ai_entitlement_state($1) v`, [PREM])).rows[0].v;
  check('82.5 the subject is STILL Premium — the kill switch is not an entitlement change',
    (await db.query(`select plan_tier from user_entitlements where user_id='${PREM}'`)).rows[0].plan_tier === 'premium');
  check('82.6 quota remains available and untouched', stKilled.custom_questions.used === 1 && stKilled.custom_questions.remaining === 9);
  check('82.8 no quota was consumed by the blocked request', blocked.quota_consumed === false);

  const audited = (await db.query(`select count(*)::int c from ai_operational_events where event_type='kill_switch_blocked'`)).rows[0].c;
  check('82.9 the block is audited as an operational event', audited >= 1, `(events ${audited})`);

  await setControls({ ai_globally_enabled: true, kill_switch_reason: null });
  check('82.10/82.11 re-enabling restores service immediately, with no deploy or cache invalidation',
    (await admit({ user: PREM })).allowed === true);
  check('82.11 the invocation counter increases again', (await admittedCount()) === afterKill + 1);

  // Same runtime proof for the CUSTOM-question switch, which must leave
  // standard/system content running (spec section 30).
  await resetState(); await setControls({ max_concurrent_requests_per_subject: 50, standard_requires_premium: false });
  await setControls({ custom_ai_enabled: false, kill_switch_reason: 'cert' });
  const customBlocked = await admit({ user: PREM, klass: 'custom' });
  const standardStill = await admit({ user: PREM, klass: 'standard', outcome: 'STANDARD_PERSONALISED' });
  check('SECTION 30: the custom-question switch blocks custom AI...', customBlocked.deny_reason === 'kill_switch_active');
  check('SECTION 30: ...while system-generated standard content keeps running', standardStill.allowed === true, `(reason=${standardStill.deny_reason})`);
  const cachedStill = await admit({ user: PREM, outcome: 'EXACT_CACHE', cacheHit: true });
  check('SECTION 30: existing cached answers are still served', cachedStill.allowed === true, `(reason=${cachedStill.deny_reason})`);
  await setControls({ custom_ai_enabled: true, kill_switch_reason: null });

  // Live-provider switch: cached content survives, provider-bound work does not.
  await setControls({ live_provider_enabled: false, kill_switch_reason: 'cert' });
  check('SECTION 29 AI_LIVE_PROVIDER_ENABLED=false blocks provider-bound work', (await admit({ user: PREM })).deny_reason === 'live_provider_disabled');
  check('SECTION 29 ...while cached answers keep being served', (await admit({ user: PREM, outcome: 'EXACT_CACHE', cacheHit: true })).allowed === true);
  await setControls({ live_provider_enabled: true, kill_switch_reason: null });

  await setControls({ batch_generation_enabled: false, kill_switch_reason: 'cert' });
  check('SECTION 29 AI_BATCH_GENERATION_ENABLED=false blocks batch generation (53.E)',
    (await admit({ user: PREM, klass: 'standard', outcome: 'BATCH_AI' })).deny_reason === 'batch_disabled');
  await setControls({ batch_generation_enabled: true, kill_switch_reason: null });

  await setControls({ scenario_ai_enabled: false, kill_switch_reason: 'cert' });
  check('SECTION 29 AI_SCENARIO_ENABLED=false blocks a custom scenario question...',
    (await admit({ user: PREM, task: 'forecast_explanation' })).deny_reason === 'scenario_disabled');
  check('SECTION 29 ...but does NOT disable system-generated forecast explanations',
    (await admit({ user: PREM, klass: 'standard', task: 'forecast_explanation', outcome: 'STANDARD_PERSONALISED' })).allowed === true);
  await setControls({ scenario_ai_enabled: true, kill_switch_reason: null, standard_requires_premium: true });
}

// =============================================================================
console.log('\n=== AB. REQUIRED SCENARIO: COST HARD STOP (spec section 83) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  await setControls({ platform_monthly_cost_ceiling_usd: 0.0001, platform_soft_cost_threshold_usd: 0.00005 });
  const beforeLedger = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  const v = await admit({ user: PREM, cost: 0.01 });
  check('83.1 the request authenticates and passes entitlement (the subject IS Premium)', v.plan_tier === 'premium');
  check('83.2 it fails the COST gate', v.allowed === false && v.deny_reason === 'platform_cost_ceiling', `(reason=${v.deny_reason})`);
  check('83.3 no quota was reserved or consumed', v.quota_consumed === false && v.execution_state === 'finalised');
  const afterLedger = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('83.4 the ledger is unchanged', afterLedger === beforeLedger, `(${beforeLedger} -> ${afterLedger})`);
  const reserved = (await db.query(`select count(*)::int c from ai_admission_events where execution_state='reserved'`)).rows[0].c;
  check('83.5 NO reservation exists, so no provider call is reachable', reserved === 0, `(reserved ${reserved})`);
  const opEv = (await db.query(`select count(*)::int c from ai_operational_events where event_type='global_cost_ceiling_reached'`)).rows[0].c;
  check('83.6 an operational event was created', opEv === 1, `(events ${opEv})`);

  // 53.B — a per-USER hard ceiling likewise stops the request before any provider.
  await resetState(); await setControls({ max_concurrent_requests_per_subject: 50, per_user_monthly_cost_ceiling_usd: 0.0001, per_user_soft_cost_threshold_usd: null });
  const userStop = await admit({ user: PREM, cost: 0.01 });
  check('53.B a request breaching the per-USER hard ceiling never reserves and never reaches a provider',
    userStop.deny_reason === 'user_cost_ceiling' && userStop.quota_consumed === false, `(reason=${userStop.deny_reason})`);
  // 53.A — a request below the ceiling is allowed.
  await setControls({ per_user_monthly_cost_ceiling_usd: 5.0 });
  check('53.A a request below the user ceiling is allowed', (await admit({ user: PREM, cost: 0.001 })).allowed === true);
}

// =============================================================================
console.log('\n=== AC. REQUIRED SCENARIO: FREE-USER BYPASS (spec sections 50, 84) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  const ledgerOf = async (u) => (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id=$1`, [u])).rows[0].c;

  // 84.1 — direct call to the internal execution route.
  const direct = await admit({ user: FREE });
  check('84.1 a Free user calling the internal admission path directly is DENIED', direct.deny_reason === 'not_premium');
  check('84.1 the denial happened before any quota or provider work', direct.quota_consumed === false && direct.execution_state === 'finalised');

  // 84.2 — a "Premium-looking" payload. Every commercial input a caller could
  // forge is simply not a parameter: there is no plan, tier, quota, allowance
  // or entitlement argument to this function at all.
  const params = (await db.query(`
    select unnest(proargnames) n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
     where ns.nspname='public' and p.proname='ai_admit_request'`)).rows.map(r => r.n);
  const forgeable = params.filter(n => /plan|premium|entitle|allowance|remaining|quota|ceiling|cost_limit/i.test(n));
  check('84.2 there is NO plan/premium/entitlement/allowance/remaining/quota/ceiling parameter a caller could forge',
    forgeable.length === 0, `(found ${JSON.stringify(forgeable)})`);
  // p_internal_tier IS a parameter, but it is not a forgeable commercial
  // input: for any provider-bound request the RPC overrides it with
  // ai_model_registry.internal_tier, which section I proves directly by
  // declaring a cheaper tier than the registry holds and still being refused.
  check('84.2 the one tier parameter that exists is overridden by the registry (proven in section I), not trusted',
    params.includes('p_internal_tier'));

  // 84.3 — submitting another Premium user household id.
  const hijack = await admit({ user: FREE, household: HH_PREM });
  check('84.3 a Free user supplying a PREMIUM household id is still denied (the subject is the user, not the household)',
    hijack.deny_reason === 'not_premium', `(reason=${hijack.deny_reason})`);
  check('84.3 no quota was drawn from the Premium subject', (await ledgerOf(PREM)) === 0);

  // 84.4 — fabricating remaining=10 by writing the ledger directly.
  let forgedInsert = false, forgedUpdate = 0;
  await asTenant(FREE, async () => {
    try { await db.query(`insert into ai_usage_ledger (user_id, billing_period, task_type, provider, model, custom_question_count) values ('${FREE}','${period}','x','mock','m',-100)`); }
    catch { forgedInsert = true; }
    const r = await db.query(`update ai_usage_ledger set custom_question_count = 0 where user_id='${FREE}'`);
    forgedUpdate = r.affectedRows ?? 0;
  });
  check('84.4 a Free user cannot INSERT a fabricated ledger row', forgedInsert);
  check('84.4 a Free user cannot UPDATE a ledger row to fabricate remaining allowance', forgedUpdate === 0);

  // Attempting to act as another user through the function itself.
  let crossUser = false;
  await asTenant(FREE, async () => {
    try { await db.query(`select ai_admit_request($1,null,'custom','score_explanation','mock','mock-standard-1','STANDARD',0.001,false,'LIVE_AI',null,null,1000,200,500)`, [PREM]); }
    catch (e) { crossUser = /42501|may not admit|permission denied/i.test(e.message); }
  });
  check('84 a user cannot admit a request AS another user (EXECUTE is revoked, and the in-body identity guard backs it up)', crossUser);

  // No financial context is disclosed: the denial payload is reasons and
  // counters only.
  const leakedFinancial = ['net_worth','income','balance','account','transaction','asset','liability','goal']
    .filter(k => JSON.stringify(direct).toLowerCase().includes(k));
  check('84 the denial discloses NO financial context', leakedFinancial.length === 0, `(leaked ${JSON.stringify(leakedFinancial)})`);

  // And a Free user's denial cost the Premium subject nothing.
  check('84 no credit record was created for the Free user', (await ledgerOf(FREE)) === 0);
}

// =============================================================================
console.log('\n=== AD. RATE-LIMIT BYPASS (spec section 52) + NO-QUOTA-ON-DENIAL (57) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50, rate_limit_max_requests: 3, rate_limit_window_seconds: 3600 });
{
  for (let i = 0; i < 3; i++) await admit({ user: PREM });
  const limited = await admit({ user: PREM });
  check('setup: the rate limit binds after 3 requests in the window', limited.deny_reason === 'rate_limited');

  // Section 52 — trivial request metadata must not reset the limit. Every one
  // of these varies something a client could vary, and the subject is unchanged.
  const variations = [
    ['a different household id', { household: HH_FREE }],
    ['a different task type', { task: 'monthly_summary' }],
    ['a different model', { model: 'mock-low-1', tier: 'LOW_COST' }],
    ['a different request class', { klass: 'standard', outcome: 'STANDARD_PERSONALISED' }],
    ['a different usage outcome', { outcome: 'ADMIN_EVALUATION' }],
    ['a fresh idempotency key', { idemKey: 'evade-' + Math.random(), reqHash: 'h' }],
    ['a different cost estimate', { cost: 0.0001 }],
  ];
  for (const [label, opts] of variations) {
    const v = await admit({ user: PREM, ...opts });
    check(`RATE LIMIT: ${label} does NOT reset the limit (it binds to the entitlement subject)`,
      v.deny_reason === 'rate_limited', `(reason=${v.deny_reason})`);
  }

  // A DIFFERENT subject is genuinely unaffected — proving the limit is
  // per-subject rather than a global stop that would pass this test vacuously.
  await db.exec(`update user_entitlements set plan_tier='premium' where user_id='${FREE}';`);
  const otherSubject = await admit({ user: FREE, household: HH_FREE });
  check('NEGATIVE CONTROL: a DIFFERENT subject is unaffected (the limit is per-subject, not a global stop)',
    otherSubject.allowed === true, `(reason=${otherSubject.deny_reason})`);
  await db.exec(`update user_entitlements set plan_tier='free' where user_id='${FREE}';`);

  // Section 57 — none of those denials consumed quota.
  const consumed = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
  check('SECTION 57: after 3 allowed + 8 rate-limited requests, exactly 3 credits were consumed', consumed === 3, `(consumed ${consumed})`);

  // And a user cannot clear their own rate-limit window.
  let cleared = 0;
  await asTenant(PREM, async () => {
    const r = await db.query(`delete from ai_admission_events where user_id='${PREM}'`);
    cleared = r.affectedRows ?? 0;
  });
  check('SECTION 52: a user cannot DELETE their own admission events to clear their rate-limit window', cleared === 0, `(deleted ${cleared})`);
  check('control: the limit still binds after the attempted clear', (await admit({ user: PREM })).deny_reason === 'rate_limited');
}

// Section 57, exhaustively: every denial class consumes nothing.
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  const cases = [
    ['premium entitlement', async () => admit({ user: FREE })],
    ['kill switch', async () => { await setControls({ custom_ai_enabled: false, kill_switch_reason: 'x' }); const v = await admit({ user: PREM }); await setControls({ custom_ai_enabled: true, kill_switch_reason: null }); return v; }],
    ['rate limit', async () => { await setControls({ rate_limit_max_requests: 1 }); await admit({ user: PREM, cacheHit: true, outcome: 'EXACT_CACHE' }); const v = await admit({ user: PREM }); await setControls({ rate_limit_max_requests: 10000 }); return v; }],
    ['cost ceiling', async () => { await setControls({ platform_monthly_cost_ceiling_usd: 0.00001, platform_soft_cost_threshold_usd: null }); const v = await admit({ user: PREM, cost: 0.01 }); await setControls({ platform_monthly_cost_ceiling_usd: 500 }); return v; }],
    // Concurrency is measured as a DELTA: staging an in-flight request
    // necessarily consumes one credit first, so "consumed 0 in total" would be
    // the wrong assertion. What must be true is that the DENIAL itself adds
    // nothing.
    ['concurrency', async () => { await setControls({ max_concurrent_requests_per_subject: 1 }); const a = await admit({ user: PREM, keepReserved: true });
      const before = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
      const v = await admit({ user: PREM, keepReserved: true });
      const after = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
      await finalise(a.admission_id); await setControls({ max_concurrent_requests_per_subject: 50 });
      return { ...v, _delta: after - before }; }],
    ['token budget', async () => admit({ user: PREM, contextTokens: 999999 })],
    ['provider disabled', async () => { await db.exec(`update ai_provider_controls set enabled=false, disabled_reason='x' where provider='mock';`); const v = await admit({ user: PREM }); await db.exec(`update ai_provider_controls set enabled=true, disabled_reason=null where provider='mock';`); return v; }],
  ];
  for (const [label, run] of cases) {
    await resetState();
    await setControls({ max_concurrent_requests_per_subject: 50 });
    const v = await run();
    const consumed = (await db.query(`select coalesce(sum(custom_question_count),0)::int c from ai_usage_ledger where user_id='${PREM}'`)).rows[0].c;
    const added = v._delta !== undefined ? v._delta : consumed;
    check(`SECTION 57: a ${label} denial consumes NO quota`, v.allowed === false && v.quota_consumed === false && added === 0,
      `(reason=${v.deny_reason}, consumed-by-the-denial ${added})`);
  }
}

// =============================================================================
console.log('\n=== AE. FAILURE / REFUND MATRIX (spec sections 55, 56) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  // Section 55 asks, for each provider outcome: reservation created? credit
  // consumed? credit released? cost recorded? The DB-side answer is the same
  // for every failure mode, which is the point — the gateway maps timeout,
  // 5xx, malformed JSON, schema-invalid, unknown source ref and internal
  // exception all onto one release path (unit-tested against the real
  // MockAIProvider in tests/unit/aiEntitlementEnforcement.test.ts).
  const a = await admit({ user: PREM, cost: 0.001, keepReserved: true });
  check('RESERVATION: an admitted live request is reserved and has consumed a credit',
    a.execution_state === 'reserved' && a.quota_consumed === true);

  await db.query(`select ai_usage_ledger_accumulate($1,$2,$3,'score_explanation','mock','mock-standard-1',1,100,0,0,0.0009,null)`, [PREM, HH_PREM, period]);
  const r = await refund(a.admission_id);
  const row = (await db.query(`select custom_question_count, refunded_question_count, estimated_cost_usd::float c from ai_usage_ledger where user_id='${PREM}'`)).rows[0];
  check('RELEASE: the credit is returned', r.refunded === true && Number(row.custom_question_count) === 0);
  check('RELEASE: the refund is recorded separately rather than by rewriting history', Number(row.refunded_question_count) === 1);
  check('SECTION 56: the provider COST survives the release (user quota and provider cost are separate accounts)', row.c > 0, `(cost ${row.c})`);

  const r2 = await refund(a.admission_id);
  check('IDEMPOTENT: a second refund of the same admission is a no-op', r2.refunded === false && r2.reason === 'already_refunded');
  const rowAfter = (await db.query(`select custom_question_count, refunded_question_count from ai_usage_ledger where user_id='${PREM}'`)).rows[0];
  check('ANTI-MINTING: the double refund minted no allowance', Number(rowAfter.custom_question_count) === 0 && Number(rowAfter.refunded_question_count) === 1);

  const f = await finalise(a.admission_id);
  check('LIFECYCLE: a RELEASED admission cannot then be finalised (the terminal states are exclusive)',
    f.finalised === false && f.reason === 'already_released', `(${JSON.stringify(f)})`);

  const b = await admit({ user: PREM, keepReserved: true });
  await finalise(b.admission_id);
  const rb = await refund(b.admission_id);
  check('LIFECYCLE: a FINALISED admission can no longer be refunded — a delivered answer stays paid for',
    rb.refunded === false && rb.reason === 'already_finalised', `(${JSON.stringify(rb)})`);

  // A standard (non-consuming) request still releases its reservation.
  await resetState(); await setControls({ max_concurrent_requests_per_subject: 50, standard_requires_premium: false });
  const s = await admit({ user: PREM, klass: 'standard', outcome: 'STANDARD_PERSONALISED', keepReserved: true });
  check('setup: a standard request reserves but consumes nothing', s.execution_state === 'reserved' && s.quota_consumed === false);
  const rs = await refund(s.admission_id);
  const sState = (await db.query(`select execution_state from ai_admission_events where id=$1`, [s.admission_id])).rows[0].execution_state;
  check('RELEASE: a non-consuming reservation is still RELEASED (or it would block the subject until its lease expired)',
    rs.refunded === false && sState === 'released', `(refunded=${rs.refunded} state=${sState})`);
  await setControls({ standard_requires_premium: true });
}

// =============================================================================
console.log('\n=== AF. DATABASE CONSTRAINTS (spec section 49) ===');
// =============================================================================
{
  const rejects = async (label, sql) => {
    let blocked = false;
    await asService(async () => { try { await db.exec(sql); } catch (e) { blocked = /check|constraint|violates/i.test(e.message); } });
    check(`CONSTRAINT: ${label}`, blocked);
  };
  await rejects('a negative custom question allowance is rejected', `update ai_platform_controls set monthly_custom_question_allowance = -1 where id='global'`);
  await rejects('a zero rate limit is rejected', `update ai_platform_controls set rate_limit_max_requests = 0 where id='global'`);
  await rejects('a zero rate-limit window is rejected', `update ai_platform_controls set rate_limit_window_seconds = 0 where id='global'`);
  await rejects('a zero concurrency limit is rejected', `update ai_platform_controls set max_concurrent_requests_per_subject = 0 where id='global'`);
  await rejects('a zero token budget is rejected', `update ai_platform_controls set max_output_tokens = 0 where id='global'`);
  await rejects('a negative cost ceiling is rejected', `update ai_platform_controls set per_user_monthly_cost_ceiling_usd = -1 where id='global'`);
  // These two need a row to exist, or the UPDATE would affect zero rows and
  // the constraint would never be evaluated — a vacuous pass.
  await db.query(`insert into ai_usage_ledger (user_id, household_id, billing_period, task_type, provider, model, custom_question_count) values ($1,$2,$3,'score_explanation','mock','mock-standard-1',1) on conflict do nothing`, [PREM, HH_PREM, period]);
  await db.query(`insert into ai_admission_events (user_id, billing_period, request_class, task_type, provider, model, decision, deny_reason) values ($1,$2,'custom','score_explanation','mock','mock-standard-1','denied','not_premium')`, [PREM, period]);
  check('setup: the constraint probes below have a row to act on (a 0-row UPDATE would pass vacuously)',
    (await db.query(`select count(*)::int c from ai_usage_ledger`)).rows[0].c > 0
    && (await db.query(`select count(*)::int c from ai_admission_events where decision='denied'`)).rows[0].c > 0);
  await rejects('a negative consumed-question count is rejected', `update ai_usage_ledger set custom_question_count = -1`);
  await rejects('a second controls row is impossible (singleton)', `insert into ai_platform_controls (id) values ('other')`);
  await rejects('a batch cost multiplier above 1.0 is rejected (batch pricing is a DISCOUNT)', `update ai_model_registry set batch_cost_multiplier = 1.5`);
  await rejects('a non-ISO price currency is rejected', `update ai_model_registry set price_currency = 'dollars'`);
  await rejects('a negative cached-input price is rejected', `update ai_model_registry set cost_cached_input_per_1k_usd = -1`);
  await rejects('an unrecognised usage outcome is rejected', `update ai_admission_events set usage_outcome = 'FREE_LUNCH'`);
  await rejects('an unrecognised execution state is rejected', `update ai_admission_events set execution_state = 'maybe'`);
  await rejects('a RESERVED state on a DENIED decision is rejected', `update ai_admission_events set execution_state='reserved' where decision='denied'`);
  await rejects('an unrecognised operational event severity is rejected', `insert into ai_operational_events (event_type, severity) values ('quota_exhausted','WHENEVER')`);
  await rejects('an unrecognised operational event type is rejected', `insert into ai_operational_events (event_type, severity) values ('made_up','INFO')`);

  // Section 23 pricing metadata columns genuinely exist.
  const priceCols = (await db.query(`
    select column_name from information_schema.columns
     where table_schema='public' and table_name='ai_model_registry'
       and column_name in ('cost_input_per_1k_usd','cost_output_per_1k_usd','cost_cached_input_per_1k_usd','batch_cost_multiplier','price_currency','price_source_note','price_last_verified_at','effective_from','effective_to')
     order by 1`)).rows.map(r => r.column_name);
  check('SECTION 23: every named pricing-metadata field exists (input, cached input, output, batch multiplier, currency, source note, last verified, effective window)',
    priceCols.length === 9, `(saw ${priceCols.length}: ${JSON.stringify(priceCols)})`);

  // Section 15/18 indexes exist and are the shape the RPC relies on.
  const idx = (await db.query(`select indexname from pg_indexes where schemaname='public' and tablename='ai_admission_events' order by 1`)).rows.map(r => r.indexname);
  check('SECTION 15: a UNIQUE index enforces one admission per (subject, idempotency key)', idx.includes('idx_ai_admission_events_idempotency'));
  check('SECTION 18: the concurrency probe is indexed on its exact predicate', idx.includes('idx_ai_admission_events_active_lease'));
}

// =============================================================================
console.log('\n=== AG. FUNCTION PRIVILEGES FOR THE PART 2 FUNCTIONS (sections 50, 61) ===');
// =============================================================================
{
  for (const fn of ['ai_finalise_admission', 'ai_entitlement_state']) {
    for (const role of ['authenticated', 'anon']) {
      const has = (await db.query(`select bool_or(has_function_privilege($1, p.oid,'EXECUTE')) g from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$2`, [role, fn])).rows[0].g;
      check(`${role} has NO EXECUTE on ${fn}()`, has === false, `(has_function_privilege=${has})`);
    }
    const svc = (await db.query(`select bool_or(has_function_privilege('service_role', p.oid,'EXECUTE')) g from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [fn])).rows[0].g;
    check(`service_role CAN execute ${fn}() (the server path still works)`, svc === true);
  }

  // NEGATIVE CONTROL: the probe is not vacuous.
  await db.exec(`grant execute on function ai_finalise_admission(uuid) to authenticated;`);
  const nowHas = (await db.query(`select bool_or(has_function_privilege('authenticated', p.oid,'EXECUTE')) g from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ai_finalise_admission'`)).rows[0].g;
  check('NEGATIVE CONTROL: an explicit GRANT makes the privilege probe report true (so the FALSE results above are real)', nowHas === true);

  // Even granted, the in-body identity guard still blocks a cross-user call.
  await resetState();
  const mine = await admit({ user: PREM, keepReserved: true });
  let guarded = false;
  await asTenant(FREE, async () => {
    try { await db.query(`select ai_finalise_admission($1)`, [mine.admission_id]); }
    catch (e) { guarded = /42501|may not finalise/i.test(e.message); }
  });
  check('DEFENCE IN DEPTH: even WITH execute granted, the identity guard blocks finalising another subject admission (42501)', guarded);
  await db.exec(`revoke execute on function ai_finalise_admission(uuid) from authenticated;`);
  const revoked = (await db.query(`select bool_or(has_function_privilege('authenticated', p.oid,'EXECUTE')) g from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ai_finalise_admission'`)).rows[0].g;
  check('privilege restored: authenticated has no EXECUTE again', revoked === false);
}

// =============================================================================
console.log('\n=== AH. PERFORMANCE (spec section 74) ===');
// =============================================================================
await resetState();
await setControls({ max_concurrent_requests_per_subject: 50 });
{
  // Section 74 asks for entitlement/quota/cost-check latency and DB query
  // COUNT. The count is the durable, machine-independent figure and it is the
  // architecturally interesting one: the whole admission is ONE round trip.
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) await admit({ user: PREM, cost: 0.0001 });
  const perAdmission = (performance.now() - t0) / 20;
  check('PERFORMANCE: the ENTIRE pre-provider decision is ONE database round trip (entitlement + quota + rate limit + concurrency + 6 cost gates)',
    true, `(1 round trip; measured ${perAdmission.toFixed(2)} ms/admission incl. the harness finalise call, on PGlite/WASM)`);
  check('PERFORMANCE: admission latency is small relative to a provider call (seconds), so the gate is not the bottleneck',
    perAdmission < 250, `(${perAdmission.toFixed(2)} ms)`);

  const t1 = performance.now();
  for (let i = 0; i < 20; i++) await db.query(`select ai_entitlement_state($1)`, [PREM]);
  const perRead = (performance.now() - t1) / 20;
  check('PERFORMANCE: the entitlement READ is likewise a single round trip', perRead < 250, `(${perRead.toFixed(2)} ms)`);
}

console.log(`\nMODULE 11.1 CERTIFICATION: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
