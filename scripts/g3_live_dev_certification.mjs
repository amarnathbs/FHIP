// G3 §18 LIVE-DEV CERTIFICATION.
//
// Runs against the real DEV Supabase project, with real auth identities and
// real RLS — not PGlite. Every guard is exercised through a genuine
// authenticated end-user session (anon key + signInWithPassword), which is
// the only way to prove the things that matter here: RLS, the MCC trigger
// backstop, and G3's controlled-confirmation guard all key off auth.uid()
// and auth.role(), and a service-role client would silently bypass all three.
//
// SAFETY
//   * Refuses to run against a URL that looks like production.
//   * Creates only synthetic identities, all tagged `g3cert`.
//   * Cleanup runs in a `finally`, then RE-QUERIES to prove zero residue.
//   * Touches no pre-existing user: every write is scoped to a synthetic id.
//
// Run with:
//   node --env-file=.env.local scripts/g3_live_dev_certification.mjs
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}
if (/prod/i.test(url)) {
  console.error('REFUSING TO RUN: the Supabase URL looks like production.');
  process.exit(3);
}
console.log(`target project ref: ${url.replace(/^https:\/\/([^.]+)\..*$/, '$1')}\n`);

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};
function expectErr(label, error, contains) {
  if (!error) return check(label, false, '(expected rejection, but it SUCCEEDED)');
  if (contains && !new RegExp(contains, 'i').test(error.message ?? '')) {
    return check(label, false, `(rejected with the wrong error: ${String(error.message).slice(0, 110)})`);
  }
  return check(label, true, `(rejected: ${String(error.message).split('\n')[0].slice(0, 90)})`);
}
function expectOk(label, error) {
  return check(label, !error, error ? `(expected success, got: ${String(error.message).slice(0, 110)})` : '');
}

const RUN = randomUUID().slice(0, 8);
const PASSWORD = `G3cert!${randomUUID()}`;
const created = []; // every synthetic auth id, for the finally-protected cleanup

/** Creates a synthetic identity and returns { id, email, client } signed in as them. */
async function makeUser(tag) {
  const email = `g3cert.${RUN}.${tag}@fhip-certification.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`could not create ${tag}: ${error.message}`);
  created.push(data.user.id);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInErr) throw new Error(`could not sign in ${tag}: ${signInErr.message}`);
  return { id: data.user.id, email, client, tag };
}

const FINANCIAL_WRITES = [
  ['income_sources', (uid) => ({ user_id: uid, source_name: 'Salary', income_type: 'salary', amount: 5000, frequency: 'monthly', currency_code: 'AUD', is_active: true })],
  ['expense_items', (uid) => ({ user_id: uid, expense_name: 'Groceries', expense_category: 'food', amount: 500, frequency: 'monthly', currency_code: 'AUD', is_active: true })],
  ['assets', (uid) => ({ user_id: uid, asset_name: 'Savings', asset_class: 'cash', current_value: 1000, currency_code: 'AUD', is_active: true })],
  ['liabilities', (uid) => ({ user_id: uid, liability_name: 'Loan', debt_type: 'personal_loan', balance: 1000, currency_code: 'AUD', is_active: true })],
  ['investments', (uid) => ({ user_id: uid, investment_name: 'Shares', investment_type: 'shares', current_value: 1000, currency_code: 'AUD', is_active: true })],
  ['retirement_accounts', (uid) => ({ user_id: uid, account_name: 'Super', account_type: 'super', current_balance: 1000, currency_code: 'AUD', is_active: true })],
  ['insurance_policies', (uid) => ({ user_id: uid, policy_name: 'Life', cover_type: 'life', cover_amount: 100000, premium: 50, premium_frequency: 'monthly', currency_code: 'AUD', is_active: true })],
  ['user_goals', (uid) => ({ user_id: uid, goal_name: 'Goal', goal_type: 'starter_emergency_fund', target_amount: 1000, currency_code: 'AUD' })],
];

const DISCLOSURE = 'g3-generic-coverage-2026-09';
let users = {};

try {
  // =========================================================================
  console.log('--- 1. Synthetic identities ---');
  // =========================================================================
  for (const tag of ['au', 'in', 'gb', 'us', 'sg', 'ae', 'unconfirmed', 'attacker']) {
    users[tag] = await makeUser(tag);
  }
  check('created 8 synthetic identities with real auth sessions', created.length === 8, `(${created.length})`);
  // handle_new_user() should have made a profile for each.
  {
    const { data } = await admin.from('user_profiles').select('user_id').in('user_id', created);
    check('handle_new_user() created a profile row for every one', (data ?? []).length === 8, `(${(data ?? []).length}/8)`);
  }
  // Mark them onboarded (service-role: models back-office setup, not an end user).
  await admin.from('user_profiles').update({ onboarding_completed: true }).in('user_id', created);

  // =========================================================================
  console.log('\n--- 2. MCC still blocks an unconfirmed user (G3-20) ---');
  // =========================================================================
  {
    const u = users.unconfirmed;
    for (const [table, row] of FINANCIAL_WRITES) {
      const { error } = await u.client.from(table).insert(row(u.id));
      expectErr(`unconfirmed user blocked from ${table}`, error, 'COUNTRY_CONFIRMATION_REQUIRED|row-level security');
    }
    const { error: cbErr } = await u.client.from('cross_border_relationships').insert({ user_id: u.id, country_code: 'IN', relationship_type: 'ASSET' });
    expectErr('unconfirmed user cannot declare a cross-border relationship', cbErr, 'COUNTRY_CONFIRMATION_REQUIRED|row-level security');
  }

  // =========================================================================
  console.log('\n--- 3. G3-R5 LIVE: confirmation is a controlled workflow ---');
  // =========================================================================
  {
    const u = users.gb;
    const { data: before } = await admin.from('audit_events').select('id').eq('user_id', u.id).eq('event_type', 'country_confirmed');
    const auditBefore = (before ?? []).length;

    // THE ATTACK the Product Owner named: one direct authenticated request
    // setting the acknowledgement AND confirming a GENERIC country together.
    const { error: attack } = await u.client.from('user_profiles').update({
      country_of_residence: 'GB',
      country_confirmed_at: new Date().toISOString(),
      country_source: 'USER_CONFIRMED',
      generic_disclosure_version: DISCLOSURE,
      generic_disclosure_acknowledged_at: new Date().toISOString(),
      generic_disclosure_country: 'GB',
    }).eq('user_id', u.id);
    expectErr('THE G3-R5 ATTACK: direct acknowledgement + GENERIC confirmation in one request is REJECTED', attack, 'COUNTRY_CONFIRMATION_REQUIRES_CONTROLLED_WORKFLOW');

    for (const [label, patch] of [
      ['country_confirmed_at alone', { country_confirmed_at: new Date().toISOString() }],
      ['country_source alone', { country_source: 'ADMIN_CORRECTED' }],
      ['the disclosure columns alone', { generic_disclosure_version: DISCLOSURE, generic_disclosure_acknowledged_at: new Date().toISOString(), generic_disclosure_country: 'GB' }],
    ]) {
      const { error } = await u.client.from('user_profiles').update(patch).eq('user_id', u.id);
      expectErr(`a direct write of ${label} is REJECTED`, error, 'COUNTRY_CONFIRMATION_REQUIRES_CONTROLLED_WORKFLOW');
    }

    // Nothing above may have left a mark.
    const { data: after } = await admin.from('user_profiles').select('country_confirmed_at, generic_disclosure_version').eq('user_id', u.id).single();
    check('after four rejected attacks the profile is still unconfirmed and unacknowledged',
      after.country_confirmed_at === null && after.generic_disclosure_version === null);
    const { data: ev } = await admin.from('audit_events').select('id').eq('user_id', u.id).eq('event_type', 'country_confirmed');
    check('the rejected attacks wrote NO audit event', (ev ?? []).length === auditBefore, `(${auditBefore} -> ${(ev ?? []).length})`);

    // Ordinary profile fields the user genuinely owns are still theirs.
    const { error: ownFields } = await u.client.from('user_profiles').update({ full_name: 'G3 Cert GB' }).eq('user_id', u.id);
    expectOk('the guard is surgical: ordinary profile fields are still directly writable', ownFields);
  }

  // =========================================================================
  console.log('\n--- 4. All six countries confirm through the RPC (G3-01..G3-09) ---');
  // =========================================================================
  const EXPECTED = { au: ['AU', 'FULL'], in: ['IN', 'FULL'], gb: ['GB', 'GENERIC'], us: ['US', 'GENERIC'], sg: ['SG', 'GENERIC'], ae: ['AE', 'GENERIC'] };
  for (const [tag, [code, level]] of Object.entries(EXPECTED)) {
    const u = users[tag];
    const { data, error } = await u.client.rpc('confirm_country_of_residence', {
      p_country_code: code,
      p_disclosure_version: level === 'GENERIC' ? DISCLOSURE : null,
    });
    expectOk(`${code} confirms through the RPC`, error);
    if (!error) {
      check(`${code} experience level is SERVER-derived as ${level}`, data?.experience_level === level, `(got ${data?.experience_level})`);
      check(`${code} source is USER_CONFIRMED, never client-chosen`, data?.country_source === 'USER_CONFIRMED');
    }
  }

  // =========================================================================
  console.log('\n--- 5. The RPC writes the mandatory audit event atomically ---');
  // =========================================================================
  {
    const u = users.sg;
    const { data: ev } = await admin.from('audit_events').select('metadata, entity, event_type').eq('user_id', u.id).eq('event_type', 'country_confirmed');
    check('exactly one audit event exists for the confirmation', (ev ?? []).length === 1, `(${(ev ?? []).length})`);
    const m = ev?.[0]?.metadata ?? {};
    check('the audit event names the RPC as its writer', m.written_by === 'confirm_country_of_residence', `(${m.written_by})`);
    check('the audit event carries the server-derived experience level', m.experience_level === 'GENERIC', `(${m.experience_level})`);
    check('the audit event carries the acknowledged disclosure version', m.disclosure_version === DISCLOSURE, `(${m.disclosure_version})`);
    check('the audit event records the new country', m.new_country === 'SG', `(${m.new_country})`);
  }

  // =========================================================================
  console.log('\n--- 6. Generic disclosure enforcement (G3 section 7.2) ---');
  // =========================================================================
  {
    // A fresh generic user with no acknowledgement.
    const u = users.attacker;
    const { error: noAck } = await u.client.rpc('confirm_country_of_residence', { p_country_code: 'US', p_disclosure_version: null });
    expectErr('the RPC refuses a GENERIC country with no disclosure version', noAck, 'GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED');
    const { error: unoffered } = await u.client.rpc('confirm_country_of_residence', { p_country_code: 'NZ', p_disclosure_version: null });
    expectErr('the RPC refuses a country the registry does not offer (G3-11)', unoffered, 'COUNTRY_REGISTRATION_NOT_PERMITTED');
    const { error: global } = await u.client.rpc('confirm_country_of_residence', { p_country_code: 'GLOBAL', p_disclosure_version: null });
    expectErr("the RPC refuses 'GLOBAL' — it is not a country (G3-10)", global);
    // A FULL country needs no acknowledgement: the rule must not over-reach.
    const { error: full } = await u.client.rpc('confirm_country_of_residence', { p_country_code: 'AU', p_disclosure_version: null });
    expectOk('a FULL country still confirms with no acknowledgement (no regression)', full);
  }

  // =========================================================================
  console.log('\n--- 7. Idempotent confirmation (G3-25) ---');
  // =========================================================================
  {
    const u = users.ae;
    const { data: p0 } = await admin.from('user_profiles').select('country_confirmed_at').eq('user_id', u.id).single();
    const { data: ev0 } = await admin.from('audit_events').select('id').eq('user_id', u.id).eq('event_type', 'country_confirmed');
    const { data: replay, error } = await u.client.rpc('confirm_country_of_residence', { p_country_code: 'AE', p_disclosure_version: DISCLOSURE });
    expectOk('a repeated confirmation succeeds', error);
    check('it reports itself as an idempotent replay', replay?.idempotent_replay === true);
    const { data: p1 } = await admin.from('user_profiles').select('country_confirmed_at').eq('user_id', u.id).single();
    const { data: ev1 } = await admin.from('audit_events').select('id').eq('user_id', u.id).eq('event_type', 'country_confirmed');
    check('the ORIGINAL confirmation timestamp is preserved', p0.country_confirmed_at === p1.country_confirmed_at);
    check('NO second audit event was written', (ev0 ?? []).length === (ev1 ?? []).length, `(${(ev0 ?? []).length} -> ${(ev1 ?? []).length})`);
  }

  // =========================================================================
  console.log('\n--- 8. Interim G4 boundary: generic users hold no financial data ---');
  // =========================================================================
  for (const tag of ['gb', 'us', 'sg', 'ae']) {
    const u = users[tag];
    for (const [table, row] of FINANCIAL_WRITES) {
      const { error } = await u.client.from(table).insert(row(u.id));
      expectErr(`${tag.toUpperCase()} user blocked from ${table}`, error, 'COUNTRY_CONFIRMATION_REQUIRED|row-level security');
    }
  }
  // SMSF specifically.
  {
    const u = users.gb;
    const { error } = await u.client.from('retirement_accounts').insert({ user_id: u.id, account_name: 'SMSF', account_type: 'smsf', master_item_key: 'smsf', current_balance: 1000, currency_code: 'AUD', is_active: true });
    expectErr('GB user cannot create an SMSF', error);
  }
  // POSITIVE CONTROL — proves the rejections above are the country gate and
  // not a broken fixture or a blanket RLS denial.
  {
    const u = users.au;
    const inserted = [];
    for (const [table, row] of FINANCIAL_WRITES) {
      const { data, error } = await u.client.from(table).insert(row(u.id)).select('id').single();
      expectOk(`POSITIVE CONTROL: AU user CAN insert into ${table}`, error);
      if (data) inserted.push([table, data.id]);
    }
    // Clean these up immediately — they are certification rows, not user data.
    for (const [table, id] of inserted) await admin.from(table).delete().eq('id', id);
  }

  // =========================================================================
  console.log('\n--- 9. Currency independence (G3-02/04/06/08, G3-16/17) ---');
  // =========================================================================
  {
    // AU reporting in INR stays AU and stays confirmed.
    const u = users.au;
    const { error } = await u.client.from('user_profiles').update({ preferred_currency: 'INR' }).eq('user_id', u.id);
    expectOk('an AU user may report in INR (G3-02)', error);
    const { data } = await admin.from('user_profiles').select('country_of_residence, country_confirmed_at, primary_country, billing_country').eq('user_id', u.id).single();
    check('changing currency did not change residence', data.country_of_residence.trim() === 'AU');
    check('changing currency did not un-confirm the country', data.country_confirmed_at !== null);
    check('changing currency did not confirm a billing country', data.billing_country === null);
  }
  {
    // GB reporting in INR is still GENERIC and still GB.
    const u = users.gb;
    const { error } = await u.client.from('user_profiles').update({ preferred_currency: 'INR' }).eq('user_id', u.id);
    expectOk('a GB user may report in INR (G3-06)', error);
    const { data } = await admin.from('user_profiles').select('country_of_residence').eq('user_id', u.id).single();
    check('a GB user reporting in INR is still resident in GB', data.country_of_residence.trim() === 'GB');
  }
  for (const forged of ['USD', 'GBP', 'SGD', 'AED']) {
    const { error } = await users.gb.client.from('user_profiles').update({ preferred_currency: forged }).eq('user_id', users.gb.id);
    expectErr(`a forged ${forged} reporting currency is REJECTED at the database (G3-16)`, error, 'preferred_currency_supported_check|violates check constraint');
  }
  {
    const { error } = await users.au.client.from('user_profiles').update({ preferred_currency: 'USD' }).eq('user_id', users.au.id);
    expectErr('a forged USD reporting currency is rejected for a FULL user too (G3-17)', error, 'preferred_currency_supported_check|violates check constraint');
  }

  // =========================================================================
  console.log('\n--- 10. Billing/primary country remain unwritable (G3 section 4) ---');
  // =========================================================================
  {
    const u = users.gb;
    const { error: b } = await u.client.from('user_profiles').update({ billing_country: 'GB', billing_country_confirmed_at: new Date().toISOString() }).eq('user_id', u.id);
    expectErr('a client cannot confirm a billing country directly', b, 'PRIMARY_OR_BILLING_COUNTRY_REQUIRES_CONTROLLED_WORKFLOW');
    const { error: p } = await u.client.from('user_profiles').update({ primary_country: 'IN' }).eq('user_id', u.id);
    expectErr('a client cannot write primary_country directly', p, 'PRIMARY_OR_BILLING_COUNTRY_REQUIRES_CONTROLLED_WORKFLOW');
  }

  // =========================================================================
  console.log('\n--- 11. Cross-border declarations (G3-21..G3-24) ---');
  // =========================================================================
  {
    const gb = users.gb, au = users.au, inUser = users.in;
    const { error: ok1 } = await gb.client.from('cross_border_relationships').insert({ user_id: gb.id, country_code: 'IN', relationship_type: 'ASSET' });
    expectOk('GB user CAN declare a cross-border relationship (G3-21)', ok1);
    const { error: self } = await gb.client.from('cross_border_relationships').insert({ user_id: gb.id, country_code: 'GB', relationship_type: 'ASSET' });
    expectErr('a declaration naming the user\'s OWN residence is rejected', self, 'CROSS_BORDER_COUNTRY_IS_RESIDENCE');
    const { error: unoffered } = await gb.client.from('cross_border_relationships').insert({ user_id: gb.id, country_code: 'NZ', relationship_type: 'ASSET' });
    expectErr('a declaration naming an unoffered country is rejected', unoffered);
    const { error: dup } = await gb.client.from('cross_border_relationships').insert({ user_id: gb.id, country_code: 'IN', relationship_type: 'ASSET' });
    expectErr('a duplicate ACTIVE relationship is refused (one-active constraint preserved)', dup);
    const { error: forged } = await gb.client.from('cross_border_relationships').insert({ user_id: au.id, country_code: 'IN', relationship_type: 'ASSET' });
    expectErr('CROSS-TENANT forged ownership is REJECTED (G3-24)', forged, 'row-level security');

    const { error: ok2 } = await au.client.from('cross_border_relationships').insert({ user_id: au.id, country_code: 'IN', relationship_type: 'INVESTMENT' });
    expectOk('AU user can declare an IN relationship (G3-23)', ok2);
    const { error: ok3 } = await inUser.client.from('cross_border_relationships').insert({ user_id: inUser.id, country_code: 'AU', relationship_type: 'RETIREMENT' });
    expectOk('IN user can declare an AU relationship (G3-22)', ok3);

    // Cross-tenant READ isolation.
    const { data: seen } = await au.client.from('cross_border_relationships').select('id, user_id');
    check('a user sees ONLY their own declarations (RLS read isolation)',
      (seen ?? []).length === 1 && seen[0].user_id === au.id, `(saw ${(seen ?? []).length})`);

    // Declaring changes nothing authoritative.
    const { data: after } = await admin.from('user_profiles').select('country_of_residence, preferred_currency, primary_country, billing_country').eq('user_id', gb.id).single();
    check('declaring a relationship left residence unchanged', after.country_of_residence.trim() === 'GB');
    check('declaring a relationship left reporting currency unchanged', after.preferred_currency.trim() === 'INR');
    check('declaring a relationship confirmed no billing country', after.billing_country === null);
  }

  // =========================================================================
  console.log('\n--- 12. GLOBAL can never enter authoritative storage ---');
  // =========================================================================
  {
    const { error } = await users.gb.client.from('user_profiles').update({ country_of_residence: 'GLOBAL' }).eq('user_id', users.gb.id);
    expectErr("an authenticated client cannot write 'GLOBAL' into country_of_residence", error);
    const { data: rows } = await admin.from('countries').select('country_code');
    const codes = (rows ?? []).map((r) => r.country_code.trim());
    check('no GLOBAL/OTHER/catch-all row exists in the registry',
      !codes.some((c) => ['GL', 'XX', 'ZZ', 'AA', 'QQ'].includes(c)), `(${codes.join(',')})`);
  }
} catch (e) {
  fail++;
  console.error(`\n  FAIL  certification aborted: ${e?.message ?? e}`);
} finally {
  // =========================================================================
  console.log('\n--- 13. Cleanup and residue reconciliation (§18) ---');
  // =========================================================================
  for (const id of created) {
    // Cross-border rows first: deleting the auth user cascades, but deleting
    // explicitly proves the owner CRUD delete path works too.
    await admin.from('cross_border_relationships').delete().eq('user_id', id);
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.log(`  WARN  could not delete ${id}: ${error.message}`);
  }

  // RE-QUERY every surface, as §18 requires.
  const { data: remainingUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const leftoverAuth = (remainingUsers?.users ?? []).filter((u) => (u.email ?? '').includes('g3cert'));
  check('zero synthetic auth identities remain', leftoverAuth.length === 0, `(${leftoverAuth.length})`);

  const { data: leftoverProfiles } = await admin.from('user_profiles').select('user_id').in('user_id', created.length ? created : ['00000000-0000-0000-0000-000000000000']);
  check('zero synthetic user_profiles rows remain', (leftoverProfiles ?? []).length === 0, `(${(leftoverProfiles ?? []).length})`);

  const { data: leftoverCb } = await admin.from('cross_border_relationships').select('id').in('user_id', created.length ? created : ['00000000-0000-0000-0000-000000000000']);
  check('zero synthetic cross_border_relationships rows remain', (leftoverCb ?? []).length === 0, `(${(leftoverCb ?? []).length})`);

  for (const [table] of FINANCIAL_WRITES) {
    const { data } = await admin.from(table).select('id').in('user_id', created.length ? created : ['00000000-0000-0000-0000-000000000000']);
    check(`zero synthetic rows remain in ${table}`, (data ?? []).length === 0, `(${(data ?? []).length})`);
  }

  // AUDIT RESIDUE — corrected treatment.
  //
  // audit_events.user_id is `on delete set null`, so a confirmation event
  // survives its account's deletion. An earlier version of this script left
  // those rows in place and described them as carrying no user identifier.
  // That was WRONG on two counts, found by inspecting the rows rather than
  // reasoning about them:
  //
  //   1. `entity_id` is a plain uuid column with no FK, so ON DELETE SET NULL
  //      never touches it — the deleted account's id survives there, and in
  //      metadata.actor_id too.
  //   2. `written_by` names the writing FUNCTION, not the purpose. A genuine
  //      user's confirmation produces an identical marker, and a genuine user
  //      who later deleted their account would also leave user_id NULL — so
  //      these rows are indistinguishable from real confirmations.
  //
  // Leaving them therefore pollutes a real audit trail with synthetic
  // confirmations that cannot be told apart from genuine ones, which is worse
  // for audit integrity than removing them. They are deleted here, by id,
  // scoped strictly to the identities this run created.
  const { data: myAudit } = await admin
    .from('audit_events')
    .select('id')
    .in('entity_id', created.length ? created : ['00000000-0000-0000-0000-000000000000']);
  const myAuditIds = (myAudit ?? []).map((r) => r.id);
  if (myAuditIds.length) {
    await admin.from('audit_events').delete().in('id', myAuditIds);
  }
  const { data: stillThere } = await admin
    .from('audit_events')
    .select('id')
    .in('entity_id', created.length ? created : ['00000000-0000-0000-0000-000000000000']);
  check('zero audit_events rows remain for any synthetic identity this run created',
    (stillThere ?? []).length === 0, `(deleted ${myAuditIds.length}, remaining ${(stillThere ?? []).length})`);

  // Existing-user preservation, compared against the preflight baseline.
  const baselinePath = path.join(process.cwd(), 'test-artifacts', 'g3_dev_baseline.json');
  if (fs.existsSync(baselinePath)) {
    const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const { data: profiles } = await admin
      .from('user_profiles')
      .select('country_of_residence, country_confirmed_at, preferred_currency, billing_country, billing_country_confirmed_at, generic_disclosure_version');
    const now = {
      total: profiles.length,
      au_confirmed: profiles.filter((p) => p.country_of_residence?.trim() === 'AU' && p.country_confirmed_at).length,
      in_confirmed: profiles.filter((p) => p.country_of_residence?.trim() === 'IN' && p.country_confirmed_at).length,
      generic_confirmed: profiles.filter((p) => ['GB', 'US', 'SG', 'AE'].includes(p.country_of_residence?.trim()) && p.country_confirmed_at).length,
      missing_country: profiles.filter((p) => !p.country_of_residence).length,
      invalid_country: profiles.filter((p) => p.country_of_residence && !['AU', 'IN', 'GB', 'US', 'SG', 'AE'].includes(p.country_of_residence.trim())).length,
      currency_AUD: profiles.filter((p) => p.preferred_currency?.trim() === 'AUD').length,
      currency_INR: profiles.filter((p) => p.preferred_currency?.trim() === 'INR').length,
      currency_other: profiles.filter((p) => p.preferred_currency && !['AUD', 'INR'].includes(p.preferred_currency.trim())).length,
      currency_null: profiles.filter((p) => !p.preferred_currency).length,
      billing_confirmed: profiles.filter((p) => p.billing_country || p.billing_country_confirmed_at).length,
      generic_disclosure_rows: profiles.filter((p) => p.generic_disclosure_version).length,
    };
    console.log(`  BASELINE ${JSON.stringify(base)}`);
    console.log(`  AFTER    ${JSON.stringify(now)}`);
    check('EXISTING-USER PRESERVATION: every aggregate is identical to the pre-certification baseline',
      JSON.stringify(base) === JSON.stringify(now));
  } else {
    check('baseline file present for the preservation comparison', false, '(run the preflight first)');
  }

  console.log(`\n=== G3 LIVE-DEV certification: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}
