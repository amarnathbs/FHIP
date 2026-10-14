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
// PART 2 (only if the promo / extension-cap migration 0237 is also applied; skipped with a
// notice otherwise): extension cap (5 allowed, 6th refused), promo create -> redeem ->
// generic refusal for a bogus code -> PARALLEL redemption of a max-3 code by 8 synthetic users
// (exactly 3 succeed, count never exceeds max), then the code is disabled. promo_codes rows are
// never deleted (trigger) so the disabled code and its audit rows remain on DEV by design.
//
// PART 3 (only if the reminders migration 0238 is also applied; skipped with a notice otherwise):
// promo default access length is 30 days; the expiry-reminder SEND-ONCE ledger via the
// service-role claim/record functions with a synthetic user (p_only_user, so no real DEV user
// can be claimed): claimed once, a rerun claims nothing, a failure is retried as the SAME row,
// a paid user is never claimed, users cannot call the functions. NO E-MAIL IS SENT by this
// script and the kill switch is NOT touched (it must still read disabled).
//
// RUN:  node scripts/admin_premium_grant_dev_proof.mjs
// ENV (read from the process environment or .env.local): NEXT_PUBLIC_SUPABASE_URL
//   (must be the DEV project), NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { digestOf, hintOf, randomCode } from './lib/promoHardeningProofCore.mjs';

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
    c.rpc('admin_manage_premium_entitlement', { p_override: false, p_action: action, p_target_user_id: target.id, p_ends_on: endsOn, p_reason: reason });

  console.log('\n=== authorisation ===');
  const nonAdmin = await manage(targetC, 'grant', day(30));
  check('a non-admin cannot call the RPC', !!nonAdmin.error && /ENTITLEMENT_ADMIN_REQUIRED|permission/i.test(nonAdmin.error.message), `(${nonAdmin.error?.message})`);

  console.log('\n=== cap (both ends inclusive: the latest last day is today plus 364) ===');
  const tooLong = await manage(adminC, 'grant', day(365));
  check('a last day of today plus 365 (366 days counting both ends) is refused', !!tooLong.error && /EXCEEDS_MAX/.test(tooLong.error.message), `(${tooLong.error?.message})`);

  console.log('\n=== lifecycle ===');
  const before = await aiState(target.id);
  check('before any grant: premium_required', before.reason === 'premium_required', `(reason=${before.reason})`);

  const g = await manage(adminC, 'grant', day(364));
  check('grant (365 days counting both ends, last day today plus 364) succeeds', !g.error && g.data?.plan_tier === 'premium', `(${g.error?.message ?? 'ok'})`);
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
  // ------------------------------------------------------------------ part 2
  const promoProbe = await svc.from('admin_users').select('can_manage_promo_codes').limit(1);
  if (promoProbe.error) {
    console.log('\n(part 2 skipped: migration 0237 not applied on DEV)');
  } else {
    console.log('\n=== extension cap (5 per grant) ===');
    const cap = await mkUser('cap');
    const capGrant = await adminC.rpc('admin_manage_premium_entitlement', { p_override: false, p_action: 'grant', p_target_user_id: cap.id, p_ends_on: day(10), p_reason: 'DEV proof: extension cap check' });
    check('grant for the cap check', !capGrant.error, `(${capGrant.error?.message ?? 'ok'})`);
    let okExt = 0;
    for (let i = 1; i <= 5; i += 1) {
      const r = await adminC.rpc('admin_manage_premium_entitlement', { p_override: false, p_action: 'extend', p_target_user_id: cap.id, p_ends_on: day(10 + i * 10), p_reason: `DEV proof: extension ${i} of 5` });
      if (!r.error) okExt += 1;
    }
    check('five extensions succeed', okExt === 5, `(${okExt})`);
    const sixth = await adminC.rpc('admin_manage_premium_entitlement', { p_override: false, p_action: 'extend', p_target_user_id: cap.id, p_ends_on: day(200), p_reason: 'DEV proof: sixth extension' });
    check('the sixth extension is refused', !!sixth.error && /EXTENSION_LIMIT_REACHED/.test(sixth.error.message), `(${sixth.error?.message})`);

    console.log('\n=== promo codes ===');
    await svc.from('admin_users').update({ can_manage_promo_codes: true }).eq('user_id', admin.id);
    const promoAdminC = await sessionClient(admin);
    // Hash only (hardening): the code is generated HERE and only its keyed digest and masked hint reach the database.
    const secret = env.PROMO_CODE_DIGEST_SECRET;
    if (!secret || secret.length < 32) throw new Error('PROMO_CODE_DIGEST_SECRET (at least 32 characters) must be in the environment so this proof can compute keyed digests the way the application does.');
    const newCode = (c, duration, max, extra = {}) =>
      c.rpc('admin_create_promo_code', {
        p_code_digest: digestOf(extra.code, secret), p_code_hint: hintOf(extra.code), p_digest_version: 1, p_duration_days: duration, p_max_redemptions: max,
        p_unlimited: false, p_expires_on: day(30), p_no_expiry: false, p_note: extra.note ?? 'DEV proof code',
      });
    const plain = randomCode();
    const made0 = await newCode(promoAdminC, 365, 3, { code: plain });
    const made = { ...made0, data: made0.data ? { ...made0.data, code: plain } : made0.data };
    check('a promo admin can create a code (only the digest and a masked hint are sent; no plain value is stored)', !made.error && typeof made.data?.id === 'string' && made.data.code_hint === hintOf(plain), `(${made.error?.message ?? 'ok'})`);
    const stored = await svc.from('promo_codes').select('code,code_digest').eq('id', made.data?.id).single();
    check('the database holds NO plain code for it', stored.data?.code === null && stored.data?.code_digest === digestOf(plain, secret), '');
    const tooLong = await newCode(promoAdminC, 366, 3, { code: randomCode() });
    check('366-day promo is refused', !!tooLong.error && /DURATION_INVALID/.test(tooLong.error.message), `(${tooLong.error?.message})`);
    const notPromoAdmin = await newCode(targetC, 30, 3, { code: randomCode() });
    check('a non-admin cannot create a code', !!notPromoAdmin.error);
    const direct = await targetC.rpc('redeem_promo_code_for_user', { p_user_id: target.id, p_digests: [digestOf(plain, secret)], p_ip_hash: null, p_email_hash: null, p_legacy_code: null });
    check('a user cannot call the redeem function directly', !!direct.error, `(${direct.error?.message})`);

    const redeemers = [];
    for (let i = 0; i < 8; i += 1) redeemers.push(await mkUser(`red${i}`));
    const results = await Promise.all(redeemers.map((u) => svc.rpc('redeem_promo_code_for_user', { p_user_id: u.id, p_digests: [digestOf(plain, secret)], p_ip_hash: null, p_email_hash: null, p_legacy_code: null })));
    const succeeded = results.filter((r) => r.data?.ok === true).length;
    const refused = results.filter((r) => r.data?.ok === false && r.data?.code === 'PROMO_CODE_UNUSABLE').length;
    check('PARALLEL: exactly 3 of 8 simultaneous redemptions of a max-3 code succeed', succeeded === 3 && refused === 5, `(ok=${succeeded}, unusable=${refused})`);
    const listed = await promoAdminC.rpc('admin_list_promo_codes_v2');
    const mine = (listed.data ?? []).find((r) => r.id === made.data?.id);
    check('redemption_count never exceeds max_redemptions', mine?.redemption_count === 3, `(count=${mine?.redemption_count})`);
    const bogus = await svc.rpc('redeem_promo_code_for_user', { p_user_id: redeemers[0].id, p_digests: [digestOf('NEVERMADE222', secret)], p_ip_hash: null, p_email_hash: null, p_legacy_code: null });
    check('a bogus code gets the same generic verdict as an exhausted one', bogus.data?.code === 'PROMO_CODE_UNUSABLE' || bogus.data?.code === 'PROMO_ALREADY_REDEEMED', `(${bogus.data?.code})`);
    const okUser = redeemers[results.findIndex((r) => r.data?.ok === true)];
    const state = await aiState(okUser.id);
    check('a redeemer is not premium_required', state.reason !== 'premium_required', `(eligible=${state.eligible}, reason=${state.reason})`);

    const off = await promoAdminC.rpc('admin_disable_promo_code', { p_id: made.data?.id, p_reason: 'DEV proof finished, disabling' });
    check('the code is disabled at the end', !off.error, `(${off.error?.message ?? 'ok'})`);

    // ---------------------------------------------------------------- part 3
    const ctl = await svc.from('premium_reminder_job_control').select('enabled').eq('job_key', 'expiry_email').maybeSingle();
    if (ctl.error) {
      console.log('\n(part 3 skipped: reminders migration 0238 not applied on DEV)');
    } else {
      console.log('\n=== promo default access length ===');
      const dflt = await newCode(promoAdminC, null, 1, { code: randomCode(), note: 'DEV proof default' });
      check('a code created without a duration defaults to 30 days, and a redemption today would end today plus 29 (both ends inclusive)', dflt.data?.duration_days === 30 && dflt.data?.ends_if_redeemed_today === day(29), `(${dflt.error?.message ?? JSON.stringify(dflt.data)})`);
      if (dflt.data?.id) await promoAdminC.rpc('admin_disable_promo_code', { p_id: dflt.data.id, p_reason: 'DEV proof finished, disabling' });

      console.log('\n=== expiry reminders (send-once ledger; nothing is e-mailed) ===');
      check('the kill switch ships DISABLED (and this script did not change it)', ctl.data?.enabled === false, `(enabled=${ctl.data?.enabled})`);
      const due = await mkUser('rem');
      const paid = await mkUser('rempaid');
      const retry = await mkUser('remretry');
      for (const u of [due, retry]) {
        await svc.from('user_entitlements').update({ plan_tier: 'premium', entitlement_source: 'admin_grant', effective_from: day(-100), effective_to: day(10), admin_grant_ends_on: day(10), reserve_source: 'admin_grant' }).eq('user_id', u.id);
      }
      await svc.from('user_entitlements').update({ plan_tier: 'premium', entitlement_source: 'payment', effective_from: day(-100), effective_to: day(10), admin_grant_ends_on: day(10), reserve_source: 'admin_grant' }).eq('user_id', paid.id);
      const claimFor = (u) => svc.rpc('premium_reminder_claim', { p_today: day(0), p_thresholds: [30], p_batch: 50, p_max_attempts: 3, p_retry_after_minutes: 60, p_only_user: u.id });

      const first = await claimFor(due);
      check('a due admin-granted entitlement is claimed once, with its own address', first.data?.length === 1 && first.data[0].email === due.email, `(${first.error?.message ?? first.data?.length})`);
      const second = await claimFor(due);
      check('an immediate rerun claims nothing (send-once)', !second.error && second.data?.length === 0, `(${second.error?.message ?? second.data?.length})`);
      const rec = await svc.rpc('premium_reminder_record', { p_ledger_id: first.data?.[0]?.ledger_id, p_ok: true, p_message_id: 'dev-proof-not-a-real-message', p_error: null, p_retry_after_minutes: 60, p_max_attempts: 3 });
      check('recording the (simulated) send succeeds, and a late failure cannot flip it', rec.data === true && (await svc.rpc('premium_reminder_record', { p_ledger_id: first.data?.[0]?.ledger_id, p_ok: false, p_message_id: null, p_error: 'late', p_retry_after_minutes: 60, p_max_attempts: 3 })).data === false);
      check('after it is sent nothing is claimed again', (await claimFor(due)).data?.length === 0);
      check('a PAID user is never claimed', (await claimFor(paid)).data?.length === 0);

      const r1 = await claimFor(retry);
      await svc.rpc('premium_reminder_record', { p_ledger_id: r1.data?.[0]?.ledger_id, p_ok: false, p_message_id: null, p_error: 'resend_http_500', p_retry_after_minutes: 60, p_max_attempts: 3 });
      check('a failed send is not retried before its delay', (await claimFor(retry)).data?.length === 0);
      await svc.from('premium_expiry_email_ledger').update({ next_attempt_at: new Date(Date.now() - 60000).toISOString() }).eq('user_id', retry.id);
      const r2 = await claimFor(retry);
      check('after the delay the SAME ledger row is retried (attempt 2), not a new one', r2.data?.length === 1 && r2.data[0].ledger_id === r1.data?.[0]?.ledger_id && r2.data[0].attempt === 2, `(${JSON.stringify(r2.data?.map((r) => r.attempt))})`);
      const rows = await svc.from('premium_expiry_email_ledger').select('id').eq('user_id', retry.id);
      check('still exactly one ledger row for the retried reminder', rows.data?.length === 1);

      const userClaim = await targetC.rpc('premium_reminder_claim', { p_today: day(0), p_thresholds: [30], p_batch: 5, p_max_attempts: 3, p_retry_after_minutes: 60, p_only_user: null });
      check('a user cannot call the claim function', !!userClaim.error, `(${userClaim.error?.message})`);
      const userLedger = await targetC.from('premium_expiry_email_ledger').select('id').limit(1);
      check('a user cannot read the ledger', !!userLedger.error || (userLedger.data ?? []).length === 0);
    }
  }
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
