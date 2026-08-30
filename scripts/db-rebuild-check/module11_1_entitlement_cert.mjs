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

/** Calls the admission RPC exactly as the application does (service role). */
async function admit(opts = {}) {
  const o = {
    user: PREM, household: HH_PREM, klass: 'custom', task: 'score_explanation',
    provider: 'mock', model: 'mock-standard-1', tier: 'STANDARD', cost: 0.001, cacheHit: false,
    ...opts,
  };
  const { rows } = await db.query(
    `select ai_admit_request($1,$2,$3,$4,$5,$6,$7,$8,$9) v`,
    [o.user, o.household, o.klass, o.task, o.provider, o.model, o.tier, o.cost, o.cacheHit]
  );
  return rows[0].v;
}
async function setControls(patch) {
  const sets = Object.entries(patch).map(([k, v]) => `${k} = ${v === null ? 'null' : typeof v === 'string' ? `'${v}'` : v}`).join(', ');
  await db.exec(`update ai_platform_controls set ${sets} where id='global';`);
}
async function resetState() {
  await db.exec(`delete from ai_admission_events; delete from ai_usage_ledger;`);
  await db.exec(`
    update ai_platform_controls set
      ai_globally_enabled = true, custom_ai_enabled = true, kill_switch_reason = null,
      standard_requires_premium = true, monthly_custom_question_allowance = 10,
      rate_limit_max_requests = 10000, rate_limit_window_seconds = 3600,
      per_user_monthly_cost_ceiling_usd = 5.0, platform_monthly_cost_ceiling_usd = 500.0,
      max_cost_per_request_usd = 0.5
    where id='global';`);
  await db.exec(`update ai_task_cost_limits set active = true, max_monthly_cost_usd = null;`);
}
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
  const seededModelRegistryTasks = (await db.query(`select unnest(task_types) t from ai_model_registry where provider='mock'`)).rows.map(r => r.t).sort();
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
  await db.exec(`grant execute on function ai_admit_request(uuid,uuid,text,text,text,text,text,numeric,boolean) to authenticated;`);
  const nowHas = (await db.query(`select bool_or(has_function_privilege('authenticated', p.oid,'EXECUTE')) g from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ai_admit_request'`)).rows[0].g;
  check('control: after an explicit GRANT the probe DOES report EXECUTE (probe is not vacuous)', nowHas === true);

  // With EXECUTE temporarily granted, the in-body identity guard is the second
  // layer — a tenant still must not be able to spend someone else's quota.
  await asTenant(FREE, async () => {
    let guarded = false, msg = '';
    try { await db.query(`select ai_admit_request($1,null,'custom','score_explanation','mock','mock-standard-1','STANDARD',0.001,false)`, [PREM]); }
    catch (e) { msg = e.message; guarded = /may not admit/i.test(e.message); }
    check('DEFENCE IN DEPTH: even WITH execute granted, a tenant cannot admit a request for another user', guarded, `(${msg.slice(0, 90)})`);
  });
  await asTenant(FREE, async () => {
    const r = (await db.query(`select ai_admit_request($1,null,'custom','score_explanation','mock','mock-standard-1','STANDARD',0.001,false) v`, [FREE])).rows[0].v;
    check('control: the same call FOR THEMSELVES is not blocked by the identity guard (it is denied on tier, not on identity)', r.deny_reason === 'not_premium', `(reason=${r.deny_reason})`);
  });
  await db.exec(`revoke execute on function ai_admit_request(uuid,uuid,text,text,text,text,text,numeric,boolean) from authenticated;`);
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
  const cheapTaskExpensiveModel = await admit({ user: PREM, klass: 'custom', task: 'dna_explanation', tier: 'ADVANCED', cost: 0.001 });
  check('MODEL/TASK LIMIT: a LOW_COST-capped task refuses to run on an ADVANCED model even when the call is cheap', cheapTaskExpensiveModel.allowed === false && cheapTaskExpensiveModel.deny_reason === 'model_tier_exceeds_task_limit', `(reason=${cheapTaskExpensiveModel.deny_reason})`);
  const cheapTaskCheapModel = await admit({ user: PREM, klass: 'custom', task: 'dna_explanation', tier: 'LOW_COST', cost: 0.001 });
  check('control: the same cheap task on a LOW_COST model is admitted', cheapTaskCheapModel.allowed === true, `(reason=${cheapTaskCheapModel.deny_reason})`);
  const advancedTaskAdvancedModel = await admit({ user: PREM, klass: 'custom', task: 'general_coach', tier: 'ADVANCED', cost: 0.001 });
  check('control: a task explicitly permitted ADVANCED is admitted on an ADVANCED model (bounded, not blanket)', advancedTaskAdvancedModel.allowed === true, `(reason=${advancedTaskAdvancedModel.deny_reason})`);
  const unknownTier = await admit({ user: PREM, klass: 'custom', task: 'dna_explanation', tier: null, cost: 0.001 });
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
  const nan = (await db.query(`select ai_admit_request($1,null,'custom','score_explanation','mock','mock-standard-1','STANDARD','NaN'::numeric,false) v`, [PREM])).rows[0].v;
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
  await resetState();
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
  const a = await admit({ user: PREM, klass: 'custom' });
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

  const cached = await admit({ user: PREM, klass: 'custom', cacheHit: true });
  const rc = (await db.query(`select ai_refund_admission($1) v`, [cached.admission_id])).rows[0].v;
  check('REFUND: a cache-hit admission consumed nothing and so refunds nothing', rc.refunded === false && rc.reason === 'nothing_to_refund', `(${JSON.stringify(rc)})`);

  const rn = (await db.query(`select ai_refund_admission('99999999-9999-9999-9999-999999999999'::uuid) v`)).rows[0].v;
  check('REFUND: an unknown admission id is rejected, not silently credited', rn.refunded === false && rn.reason === 'not_found', `(${JSON.stringify(rn)})`);

  // Refunded quota is genuinely reusable.
  await resetState();
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push((await admit({ user: PREM, klass: 'custom' })).admission_id);
  const exhausted = await admit({ user: PREM, klass: 'custom' });
  check('setup: allowance exhausted at 10', exhausted.deny_reason === 'quota_exhausted');
  await db.query(`select ai_refund_admission($1)`, [ids[0]]);
  const reused = await admit({ user: PREM, klass: 'custom' });
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

console.log(`\nMODULE 11.1 CERTIFICATION: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
