// Admin Premium grant (migration 0231) — DEV end-to-end proof. PO-RUN, AFTER
// migration 0231 has been applied to DEV. It was NOT run by the engineer who
// built the feature (no sanctioned DDL path to DEV was available, and creating
// accounts was out of bounds), so nothing in the report may claim it passed.
//
// WHAT IT DOES (synthetic accounts only; everything created is removed):
//   1. Refuses to run against anything but the DEV project, and never against
//      production (twwpnltizhtjxhamyoxt).
//   2. Refuses to run unless migration 0231 is present (probes the new column).
//   3. Creates two synthetic users (an admin and a target), gives the admin the
//      capability, and signs the admin in with a randomly generated password
//      that is never printed or stored.
//   4. Lifecycle through the REAL RPC as an authenticated user:
//        grant      -> ai_entitlement_state is NOT premium_required (eligible, or
//                      held only by an AI kill switch)
//        backdate effective_to (service role, synthetic row only) -> premium_required
//        extend     -> not premium_required again
//        revoke     -> premium_required
//      plus: a non-admin cannot call the RPC; 366 days is refused; the audit
//      trail holds one row per successful action.
//   5. Cleans up: capability row, auth users (cascades entitlement rows).
//      admin_entitlement_events is APPEND-ONLY by design, so its handful of rows
//      for the deleted synthetic users remain and are reported.
//
// RUN:  node scripts/admin_premium_grant_dev_proof.mjs
// ENV (read from the process environment or .env.local): NEXT_PUBLIC_SUPABASE_URL
//   (must be the DEV project), NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const DEV_REF = 'vqycarelcoijzwlpkpcz';
const PROD_REF = 'twwpnltizhtjxhamyoxt';

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const k = line.slice(0, i);
      if (env[k] === undefined) env[k] = line.slice(i + 1).trim();
    }
  } catch {
    /* env file optional */
  }
  return env;
}

const env = loadEnv();
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
if (URL_.includes(PROD_REF) || !URL_.includes(DEV_REF)) {
  console.error(`REFUSING: NEXT_PUBLIC_SUPABASE_URL must be the DEV project (${DEV_REF}); never production.`);
  process.exit(2);
}
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!ANON || !SERVICE) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

const svc = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label} ${detail}`);
};

const probe = await svc.from('user_entitlements').select('entitlement_source').limit(1);
if (probe.error) {
  console.error('Migration 0231 is not applied on DEV (entitlement_source missing). Apply it first. Nothing was changed.');
  process.exit(3);
}

const stamp = Date.now();
const created = [];
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function mkUser(label) {
  const email = `premium-grant-proof-${label}-${stamp}@example.invalid`;
  const password = crypto.randomBytes(24).toString('base64url') + 'aA1!';
  const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser(${label}): ${error.message}`);
  created.push(data.user.id);
  return { id: data.user.id, email, password };
}

async function sessionClient(u) {
  const anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`signIn(${u.email}): ${error.message}`);
  return createClient(URL_, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

const aiState = async (id) => (await svc.rpc('ai_entitlement_state', { p_user_id: id })).data ?? {};

try {
  const admin = await mkUser('admin');
  const target = await mkUser('target');

  const capRow = await svc.from('admin_users').insert({ user_id: admin.id, can_manage_premium_entitlements: true, notes: 'synthetic premium-grant proof' });
  if (capRow.error) throw new Error(`admin_users insert: ${capRow.error.message}`);

  const adminC = await sessionClient(admin);
  const targetC = await sessionClient(target);
  const manage = (c, action, endsOn, reason = 'DEV proof: synthetic lifecycle check') =>
    c.rpc('admin_manage_premium_entitlement', { p_action: action, p_target_user_id: target.id, p_ends_on: endsOn, p_reason: reason });

  console.log('\n=== authorisation ===');
  const nonAdmin = await manage(targetC, 'grant', day(30));
  check('a non-admin cannot call the RPC', !!nonAdmin.error && /ENTITLEMENT_ADMIN_REQUIRED|permission/i.test(nonAdmin.error.message), `(${nonAdmin.error?.message})`);

  console.log('\n=== cap ===');
  const tooLong = await manage(adminC, 'grant', day(366));
  check('366 days is refused', !!tooLong.error && /EXCEEDS_MAX/.test(tooLong.error.message), `(${tooLong.error?.message})`);

  console.log('\n=== lifecycle ===');
  const before = await aiState(target.id);
  check('before any grant: premium_required', before.reason === 'premium_required', `(reason=${before.reason})`);

  const g = await manage(adminC, 'grant', day(365));
  check('grant (365 days) succeeds', !g.error && g.data?.plan_tier === 'premium', `(${g.error?.message ?? 'ok'})`);
  const afterGrant = await aiState(target.id);
  check('grant -> AI entitlement state is not premium_required', afterGrant.reason !== 'premium_required', `(eligible=${afterGrant.eligible}, reason=${afterGrant.reason})`);

  const back = await svc.from('user_entitlements').update({ effective_to: day(-1) }).eq('user_id', target.id);
  check('(setup) synthetic row backdated by service role', !back.error);
  const expired = await aiState(target.id);
  check('expired -> premium_required', expired.eligible === false && expired.reason === 'premium_required', `(eligible=${expired.eligible}, reason=${expired.reason})`);

  const ext = await manage(adminC, 'extend', day(60), 'DEV proof: extend after lapse');
  check('extend of a lapsed grant succeeds and re-activates', !ext.error && ext.data?.effective_from === day(0), `(${ext.error?.message ?? ext.data?.effective_from})`);
  const afterExt = await aiState(target.id);
  check('extend -> not premium_required again', afterExt.reason !== 'premium_required', `(eligible=${afterExt.eligible}, reason=${afterExt.reason})`);

  const rev = await manage(adminC, 'revoke', null, 'DEV proof: revoke at end of check');
  check('revoke succeeds', !rev.error && rev.data?.plan_tier === 'free', `(${rev.error?.message ?? 'ok'})`);
  const afterRev = await aiState(target.id);
  check('revoke -> premium_required', afterRev.eligible === false && afterRev.reason === 'premium_required', `(eligible=${afterRev.eligible}, reason=${afterRev.reason})`);

  console.log('\n=== audit ===');
  const hist = await adminC.rpc('admin_premium_entitlement_history', { p_target_user_id: target.id, p_limit: 50 });
  check('history holds exactly grant, extend, revoke (newest first); rejected calls left no row', !hist.error && JSON.stringify((hist.data ?? []).map((r) => r.action)) === JSON.stringify(['revoke', 'extend', 'grant']), `(${hist.error?.message ?? (hist.data ?? []).map((r) => r.action).join(',')})`);
  const nonAdminHist = await targetC.rpc('admin_premium_entitlement_history', { p_target_user_id: target.id, p_limit: 50 });
  check('a non-admin cannot read the history', !!nonAdminHist.error);
} catch (e) {
  fail += 1;
  console.log(`  FAIL  unexpected error: ${e.message}`);
} finally {
  console.log('\n=== cleanup ===');
  for (const id of created) {
    await svc.from('admin_users').delete().eq('user_id', id);
    const { error } = await svc.auth.admin.deleteUser(id);
    console.log(`  ${error ? 'FAIL' : 'ok  '}  delete synthetic user ${id.slice(0, 8)}… ${error?.message ?? ''}`);
    if (error) fail += 1;
  }
  console.log('  note: admin_entitlement_events is append-only by design; its rows for the deleted synthetic users remain.');
  console.log(`\nADMIN PREMIUM GRANT DEV PROOF: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
