// Mandatory Country Confirmation — clean-rebuild replay + DB-trigger
// enforcement certification, using the repo's established PGlite harness
// pattern (scripts/db-rebuild-check/{shim.sql,smsf_jurisdiction_cert.mjs}).
//
// Proves, against a REAL Postgres engine (PGlite/WASM), not a mock:
//   1. The full migration chain (0001-0105) replays cleanly from empty.
//   2. handle_new_user still creates a profile with country fields null —
//      migration 0104/0105 does not break signup.
//   3. An unconfirmed user's direct INSERT into every one of the 8
//      originally-named financial tables is rejected.
//   4. Confirming a supported country makes those same inserts succeed.
//   5. A recognised-but-unsupported country (is_supported=false) does NOT
//      count as confirmed, even with country_confirmed_at set.
//   6. service_role writes are never blocked by the trigger.
//   7. Existing rows created before confirmation are preserved byte-for-byte
//      (spec 1.3/6.2) — never deleted, hidden or rewritten by a later
//      confirmation.
//   8. (round 2 / 0105) The onboarding-exemption bugfix: a user who has NOT
//      completed onboarding can still insert into a backstopped table (the
//      wizard's own optional "first goal" step), and the SAME insert is
//      correctly rejected once onboarding_completed flips true without the
//      user ever confirming a country.
//   9. (round 2 / 0105) A representative sample of the 69 newly-backstopped
//      GENERIC tables (fdh_financial_accounts, financial_health_scores)
//      reject/accept identically to the original 8.
//  10. (round 2 / 0105) The two BESPOKE triggers — professional_notes
//      (owner column author_user_id) and financial_twin_insights (owner
//      resolved via a join to financial_twin_runs) — reject/accept based on
//      the correct underlying user's confirmation state, not the row's own
//      (nonexistent) user_id.
//  11. (round 2 / 0105) The 2 principal EXCLUDED tables behave as intended:
//      user_profiles' own bootstrap insert is never blocked (already proven
//      by check #2), and consents accepts a direct insert from a completely
//      unconfirmed user (spec 1.2's consent/privacy/terms carve-out).
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.stack); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));

const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
let replayed = 0;
for (const f of files) {
  const sql = fs
    .readFileSync(path.join(MIG, f), 'utf8')
    .replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
  try {
    await db.exec(sql);
    replayed++;
  } catch (e) {
    console.error(`\nREPLAY FAILED at ${f}\n${e.message}\n`);
    process.exit(3);
  }
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}
console.log(`REPLAY COMPLETE: ${replayed}/${files.length} migrations applied cleanly (0001 -> ${files[files.length - 1]})\n`);

var pass = 0,
  fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label} ${detail}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
};
async function expectReject(label, fn) {
  try {
    await fn();
    check(label, false, '(expected rejection, but it succeeded)');
  } catch (e) {
    check(label, true, `(rejected: ${e.message.slice(0, 120)})`);
  }
}
async function expectOk(label, fn) {
  try {
    const r = await fn();
    check(label, true);
    return r;
  } catch (e) {
    check(label, false, `(unexpected error: ${e.message.slice(0, 160)})`);
  }
}
async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}
async function asService(fn) {
  // Real Supabase PostgREST sets BOTH the Postgres session role AND the
  // request.jwt.claims GUC (decoded from the service-role JWT, whose own
  // payload carries `"role":"service_role"`) for every service-role
  // request — auth.role() (used by enforce_country_confirmed()) reads the
  // JWT claim, not the bare Postgres role, so a harness that only does
  // `set role service_role` without also setting the claim under-tests the
  // real platform behaviour. Mirrors asTenant()'s own set_config call.
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await db.exec(`set role service_role;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;`);
  }
}

const U1 = '11111111-1111-1111-1111-111111111111'; // will confirm AU
const U2 = '22222222-2222-2222-2222-222222222222'; // stays unconfirmed
const U3 = '33333333-3333-3333-3333-333333333333'; // recognised-but-unsupported (NZ)

console.log('=== Setup: 3 tenants via real signup trigger ===');
await db.exec(`insert into auth.users(id,email) values ('${U1}','u1@t.test'),('${U2}','u2@t.test'),('${U3}','u3@t.test');`);
{
  const { rows } = await db.query(
    `select country_of_residence, country_confirmed_at, country_source from user_profiles where user_id in ('${U1}','${U2}','${U3}')`
  );
  // NOTE: this check runs BEFORE the onboarding_completed backfill just
  // below — country fields must be null regardless of onboarding state.
  check('handle_new_user still creates a profile row for every new auth.users insert (0104 does not break signup)', rows.length === 3);
  check(
    'every freshly created profile has country_of_residence/country_confirmed_at/country_source all null (no silent default)',
    rows.every((r) => r.country_of_residence === null && r.country_confirmed_at === null && r.country_source === null)
  );
}

// Round 2's onboarding-exemption bugfix (0105) means the trigger now also
// checks onboarding_completed — every existing "unconfirmed" fixture below
// (U1 pre-confirmation, U2, U3) represents a POST-onboarding, country-
// unconfirmed real-world user (the actual scenario the backstop exists
// for), not a still-onboarding one (which is separately, deliberately
// exempt — see U4 below). Marking onboarding_completed=true here, with
// country still completely unset, is what makes every "is rejected" check
// below a genuine test of the confirmation gate rather than an accidental
// pass/fail driven by onboarding status.
await db.exec(`update user_profiles set onboarding_completed = true where user_id in ('${U1}','${U2}','${U3}')`);

console.log('\n=== is_country_confirmed() + trigger reject unconfirmed users on every backstopped table ===');
{
  const { rows } = await db.query(`select public.is_country_confirmed('${U2}') as c`);
  check('is_country_confirmed() is FALSE for a brand-new profile (null country)', rows[0].c === false);
}

const insertAttempts = {
  income_sources: `insert into income_sources (user_id, source_name, income_type, amount, frequency, currency_code) values ('${U2}','Salary','salary',1000,'monthly','AUD')`,
  expense_items: `insert into expense_items (user_id, expense_name, expense_category, amount, frequency, currency_code) values ('${U2}','Rent','housing',500,'monthly','AUD')`,
  assets: `insert into assets (user_id, asset_name, asset_class, current_value, currency_code) values ('${U2}','Savings','cash',1000,'AUD')`,
  liabilities: `insert into liabilities (user_id, liability_name, debt_type, balance, currency_code) values ('${U2}','Card','credit_card',200,'AUD')`,
  investments: `insert into investments (user_id, investment_name, investment_type, current_value, currency_code) values ('${U2}','ETF','etf',500,'AUD')`,
  retirement_accounts: `insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code) values ('${U2}','Super','super',5000,'AUD')`,
  insurance_policies: `insert into insurance_policies (user_id, policy_name, cover_type, cover_amount, premium, premium_frequency, currency_code) values ('${U2}','Life','life',100000,10,'monthly','AUD')`,
  user_goals: `insert into user_goals (user_id, goal_name, goal_type, target_amount, currency_code) values ('${U2}','Emergency fund','starter_emergency_fund',3000,'AUD')`,
};

await asTenant(U2, async () => {
  for (const [table, sql] of Object.entries(insertAttempts)) {
    await expectReject(`unconfirmed user's direct INSERT into ${table} is rejected`, () => db.query(sql));
  }
});

console.log('\n=== Confirming a supported country flips every table from reject to allow ===');
await db.exec(
  `update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id='${U1}'`
);
{
  const { rows } = await db.query(`select public.is_country_confirmed('${U1}') as c`);
  check('is_country_confirmed() is TRUE once country_of_residence + country_confirmed_at are both set to a supported code', rows[0].c === true);
}
let preservedIds = {};
await asTenant(U1, async () => {
  for (const [table, sql] of Object.entries(insertAttempts)) {
    const asU1 = sql.replaceAll(U2, U1);
    const row = await expectOk(`confirmed AU user's direct INSERT into ${table} now succeeds`, async () => {
      const r = await db.query(asU1 + ' returning id');
      return r.rows[0].id;
    });
    preservedIds[table] = row;
  }
});

console.log('\n=== Recognised-but-unsupported country (NZ) never counts as confirmed, even with a timestamp ===');
await db.exec(`insert into countries (country_code, country_name, default_currency_code, is_supported) values ('NZ','New Zealand','NZD',false) on conflict do nothing;`);
await db.exec(
  `update user_profiles set country_of_residence='NZ', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id='${U3}'`
);
{
  const { rows } = await db.query(`select public.is_country_confirmed('${U3}') as c`);
  check('is_country_confirmed() is FALSE for a recognised-but-unsupported country even with country_confirmed_at set (never a false positive)', rows[0].c === false);
}
await asTenant(U3, async () => {
  await expectReject('NZ (unsupported) user is still rejected by the trigger despite holding a confirmation timestamp', () =>
    db.query(insertAttempts.assets.replaceAll(U2, U3))
  );
});

console.log('\n=== service_role bypass — background/admin writes are never blocked ===');
await asService(async () => {
  await expectOk('service_role INSERT for the still-unconfirmed U2 succeeds (admin/background remediation is not blocked)', () =>
    db.query(insertAttempts.assets)
  );
});

console.log('\n=== Existing-data preservation across confirmation (spec 1.3/6.2) ===');
{
  const before = await db.query(`select id, current_value from assets where user_id='${U1}' and id='${preservedIds.assets}'`);
  check('the row inserted right after confirmation is readable, unchanged, with its real value intact', before.rows.length === 1 && Number(before.rows[0].current_value) === 1000);

  // Now change U1's country (simulating spec 5.7's reconfirmation-reset) and
  // verify the SAME pre-existing rows are still present afterwards,
  // unmodified — country changes never delete/hide/rewrite history.
  await db.exec(`update user_profiles set country_confirmed_at=null, country_source=null, country_of_residence='IN', country_updated_at=now() where user_id='${U1}'`);
  const stillThere = await db.query(`select id, current_value, asset_name from assets where user_id='${U1}' and id='${preservedIds.assets}'`);
  check(
    'after country_of_residence changes and confirmation resets to unconfirmed, the pre-existing asset row is still present, unmodified',
    stillThere.rows.length === 1 && stillThere.rows[0].asset_name === 'Savings' && Number(stillThere.rows[0].current_value) === 1000
  );
  const allEightStillCount = await Promise.all(
    Object.keys(insertAttempts).map(async (t) => (await db.query(`select count(*)::int c from ${t} where user_id='${U1}'`)).rows[0].c)
  );
  check('every one of the 8 tables still shows exactly 1 row for U1 after the country change (nothing deleted)', allEightStillCount.every((c) => c === 1), `(${JSON.stringify(allEightStillCount)})`);
}

console.log('\n=== (round 3) Gap 1 CLOSED — the onboarding exemption is narrowed to households INSERT/UPDATE only ===');
const U4 = '44444444-4444-4444-4444-444444444444';
await db.exec(`insert into auth.users(id,email) values ('${U4}','u4@t.test');`);
{
  const { rows } = await db.query(`select onboarding_completed from user_profiles where user_id='${U4}'`);
  check('U4 starts with onboarding_completed = false (real signup default)', rows[0].onboarding_completed === false);
}
await asTenant(U4, async () => {
  // THE EXACT ROUND-2 DEFECT, reproduced and now proven fixed: a
  // not-yet-onboarded user's direct INSERT into a financial table (assets —
  // nothing to do with the household step) must be REJECTED. Round 2's
  // trigger wrongly allowed this for ANY of the 80 tables whenever
  // onboarding_completed was false.
  await expectReject(
    'Gap 1 FIX PROOF: a not-yet-onboarded user cannot INSERT into assets (round-2 defect: this used to wrongly succeed for every one of the 80 tables)',
    () => db.query(`insert into assets (user_id, asset_name, asset_class, current_value, currency_code) values ('${U4}','Fraudulent asset','cash',999999,'AUD')`)
  );
  // The ONE legitimate exemption: households INSERT, before onboarding
  // completes — this is what the onboarding wizard's PUT /api/household
  // call actually needs, and the only thing narrowed exemption still allows.
  await expectOk('households INSERT still succeeds for the same not-yet-onboarded user (the one narrow, table-scoped exemption)', () =>
    db.query(`insert into households (user_id, household_type, dependants_count) values ('${U4}','single',0)`)
  );
  await expectOk('households UPDATE also still succeeds pre-onboarding (the wizard\'s PUT is an upsert)', () =>
    db.query(`update households set dependants_count = 1 where user_id = '${U4}'`)
  );
  // DELETE on households is explicitly NOT part of the narrow exemption —
  // only INSERT and UPDATE are (the wizard never deletes a household during
  // onboarding, so there is no legitimate case to exempt).
  await expectReject('households DELETE is NOT exempted even pre-onboarding — the exemption is scoped to INSERT/UPDATE only, never DELETE', () =>
    db.query(`delete from households where user_id = '${U4}'`)
  );
  // And household_members — a DIFFERENT table, never written during
  // onboarding — gets NO exemption of any kind, proving the fix is scoped
  // to the households TABLE specifically, not a blanket "household-ish"
  // carve-out.
  await expectReject('household_members gets NO onboarding exemption at all (different table, never legitimately written during onboarding)', () =>
    db.query(`insert into household_members (user_id, household_id, full_name, relationship) values ('${U4}', (select id from households where user_id='${U4}'), 'Spouse Name', 'spouse')`)
  );
});
await db.exec(`update user_profiles set onboarding_completed = true where user_id='${U4}'`);
await asTenant(U4, async () => {
  await expectReject(
    'households INSERT is correctly rejected once onboarding_completed flips true, with country still unconfirmed (exemption turns off)',
    () => db.query(`insert into households (user_id, household_type, dependants_count) values ('${U4}','single',0) on conflict do nothing`)
  );
  await expectReject(
    'the optional first-goal write itself (moved out of onboarding entirely, round-3 fix) is rejected here too — it is never inserted during onboarding any more',
    () => db.query(`insert into user_goals (user_id, goal_name, goal_type, target_amount, currency_code) values ('${U4}','Emergency fund','starter_emergency_fund',1000,'AUD')`)
  );
});

// U1 was deliberately un-confirmed again by the existing-data-preservation
// section above (its country was changed to 'IN' with confirmation reset,
// to prove records survive that change) — re-confirm it here so the round-2
// checks below start from a known CONFIRMED state, independent of that
// earlier section's own end state.
await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${U1}'`);

console.log('\n=== (round 2) Representative sample of the 69 newly-backstopped GENERIC tables ===');
await asTenant(U2, async () => {
  await expectReject('unconfirmed user direct INSERT into fdh_financial_accounts is rejected', () =>
    db.query(
      `insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name) values ('${U2}','savings','AU','AUD','Everyday')`
    )
  );
  await expectReject('unconfirmed user direct INSERT into financial_health_scores is rejected', () =>
    db.query(
      `insert into financial_health_scores (user_id, score_month, overall_score, rounded_score, status_band, data_confidence, model_version) values ('${U2}','2026-08-01',72.5,73,'good',80,'v1')`
    )
  );
});
await asTenant(U1, async () => {
  await expectOk('confirmed user direct INSERT into fdh_financial_accounts now succeeds', () =>
    db.query(
      `insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name) values ('${U1}','savings','AU','AUD','Everyday')`
    )
  );
  await expectOk('confirmed user direct INSERT into financial_health_scores now succeeds', () =>
    db.query(
      `insert into financial_health_scores (user_id, score_month, overall_score, rounded_score, status_band, data_confidence, model_version) values ('${U1}','2026-08-01',72.5,73,'good',80,'v1')`
    )
  );
});

console.log('\n=== (round 2) BESPOKE trigger: professional_notes (owner column author_user_id) ===');
const CLIENT = '55555555-5555-5555-5555-555555555555';
const PRO = '66666666-6666-6666-6666-666666666666';
await db.exec(`insert into auth.users(id,email) values ('${CLIENT}','client@t.test'),('${PRO}','pro@t.test');`);
await db.exec(`update user_profiles set onboarding_completed = true where user_id = '${PRO}'`); // see U1/U2/U3 note above
let relId;
await asService(async () => {
  const r = await db.query(
    `insert into professional_relationships (client_user_id, professional_user_id, status, invited_by) values ('${CLIENT}','${PRO}','active','client') returning id`
  );
  relId = r.rows[0].id;
  await db.query(`insert into professional_permission_scopes (relationship_id, scope, granted_by) values ('${relId}','COMMENT_OR_NOTE','client')`);
});
await asTenant(PRO, async () => {
  await expectReject('a country-unconfirmed professional cannot insert a professional_notes row (bespoke author_user_id trigger)', () =>
    db.query(
      `insert into professional_notes (relationship_id, author_user_id, subject_type, note_text) values ('${relId}','${PRO}','general','Reviewed the portfolio.')`
    )
  );
});
await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${PRO}'`);
await asTenant(PRO, async () => {
  await expectOk('the same professional, once THEY confirm their own country, can insert the note', () =>
    db.query(
      `insert into professional_notes (relationship_id, author_user_id, subject_type, note_text) values ('${relId}','${PRO}','general','Reviewed the portfolio.')`
    )
  );
});

console.log('\n=== (round 2) BESPOKE trigger: financial_twin_insights (owner resolved via join to financial_twin_runs) ===');
let twinRunId;
await asService(async () => {
  const r = await db.query(`insert into financial_twin_runs (user_id) values ('${U2}') returning id`);
  twinRunId = r.rows[0].id;
});
await asTenant(U2, async () => {
  await expectReject('unconfirmed run-owner cannot insert a financial_twin_insights row against their own existing run (bespoke join-based trigger)', () =>
    db.query(
      `insert into financial_twin_insights (financial_twin_run_id, insight_type, title, explanation) values ('${twinRunId}','gap','Title','Explanation text.')`
    )
  );
});
let twinRunIdU1;
await asService(async () => {
  const r = await db.query(`insert into financial_twin_runs (user_id) values ('${U1}') returning id`);
  twinRunIdU1 = r.rows[0].id;
});
await asTenant(U1, async () => {
  await expectOk('a confirmed run-owner can insert a financial_twin_insights row against their own run', () =>
    db.query(
      `insert into financial_twin_insights (financial_twin_run_id, insight_type, title, explanation) values ('${twinRunIdU1}','gap','Title','Explanation text.')`
    )
  );
});

console.log('\n=== (round 2) EXCLUDED tables behave as intended ===');
await asTenant(U2, async () => {
  await expectOk('a completely unconfirmed user can still write to consents directly (spec 1.2 consent/privacy/terms carve-out)', () =>
    db.query(`insert into consents (user_id, consent_type, consent_version) values ('${U2}','terms','v1')`)
  );
});

console.log('\n=== (round 3) Gap 2 CLOSED — real UPDATE/DELETE rejection tests, not inference from INSERT ===');
{
  // Seed a real pre-existing row for U2 via service-role (simulating data
  // that existed before this feature, or was legitimately created while
  // U2 was briefly confirmed) — then prove an unconfirmed U2 cannot UPDATE
  // or DELETE it directly, and that it survives both blocked attempts
  // completely unchanged.
  let assetId;
  await asService(async () => {
    const r = await db.query(
      `insert into assets (user_id, asset_name, asset_class, current_value, currency_code) values ('${U2}','Pre-existing savings','cash',5000,'AUD') returning id`
    );
    assetId = r.rows[0].id;
  });
  await asTenant(U2, async () => {
    await expectReject('Gap 2: unconfirmed user direct UPDATE of their OWN existing assets row is rejected', () =>
      db.query(`update assets set current_value = 1 where id = '${assetId}'`)
    );
    await expectReject('Gap 2: unconfirmed user direct DELETE of their OWN existing assets row is rejected', () =>
      db.query(`delete from assets where id = '${assetId}'`)
    );
  });
  const stillThere = await asService(() => db.query(`select current_value, asset_name from assets where id = '${assetId}'`));
  check(
    'the row survives both blocked UPDATE and DELETE attempts completely unchanged (existing-data preservation, not just inferred)',
    stillThere.rows.length === 1 && Number(stillThere.rows[0].current_value) === 5000 && stillThere.rows[0].asset_name === 'Pre-existing savings'
  );

  console.log('\n=== (round 3) SELECT justification — live-tested, not asserted ===');
  await asTenant(U2, async () => {
    const own = await expectOk('an unconfirmed user CAN still SELECT their own pre-existing row directly (deliberate: spec 5.6 permits continued read-only access to already-existing preserved records)', () =>
      db.query(`select id from assets where id = '${assetId}'`)
    );
    check('...and the row is actually returned, not silently filtered to empty', own.rows.length === 1);
  });
  await asTenant(U1, async () => {
    const crossTenant = await expectOk('cross-tenant SELECT query itself does not error (RLS filters silently, as always)', () =>
      db.query(`select id from assets where id = '${assetId}'`)
    );
    check('a DIFFERENT (confirmed) tenant reading U2\'s row id gets ZERO rows — pre-existing owner-only RLS is completely unaffected by this feature', crossTenant.rows.length === 0);
  });

  // Once confirmed, U2's own UPDATE/DELETE work normally again — the gate
  // never permanently damages a user's ability to manage their own data,
  // it only requires confirmation first.
  await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${U2}'`);
  await asTenant(U2, async () => {
    await expectOk('once U2 confirms, the SAME UPDATE now succeeds', () => db.query(`update assets set current_value = 5500 where id = '${assetId}'`));
    await expectOk('and the SAME DELETE now succeeds too', () => db.query(`delete from assets where id = '${assetId}'`));
  });
}

console.log('\n=== (round 3) New tables discovered this round: FDH-10 merge (INSERT+UPDATE) ===');
await asTenant(U4, async () => {
  await expectReject('unconfirmed user cannot INSERT into fdh_liability_statements (new from the FDH-10 merge)', () =>
    db.query(`insert into fdh_liability_statements (user_id, statement_type, facility_type, currency_code) values ('${U4}','credit_card','credit_card','AUD')`)
  );
});
await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${U4}'`);
let liabilityStatementId;
await asTenant(U4, async () => {
  liabilityStatementId = await expectOk('confirmed user CAN insert into fdh_liability_statements', async () => {
    const r = await db.query(
      `insert into fdh_liability_statements (user_id, statement_type, facility_type, currency_code) values ('${U4}','credit_card','credit_card','AUD') returning id`
    );
    return r.rows[0].id;
  });
});
// Reset U4 to unconfirmed for the UPDATE-rejection check below.
await db.exec(`update user_profiles set country_confirmed_at=null, country_source=null where user_id='${U4}'`);
await asTenant(U4, async () => {
  await expectReject('the same now-unconfirmed-again user cannot UPDATE their own fdh_liability_statements row', () =>
    db.query(`update fdh_liability_statements set institution_name = 'Forged Bank' where id = '${liabilityStatementId}'`)
  );
});

console.log('\n=== (round 3) New tables discovered this round: UPDATE-only policies (no INSERT for authenticated) ===');
{
  let ircId;
  await asService(async () => {
    const r = await db.query(
      `insert into ii_reconciliation_cases (user_id, subject_type, subject_id, status, discrepancy_type) values ('${U1}','account','${crypto.randomUUID()}','open','other') returning id`
    );
    ircId = r.rows[0].id;
  });
  // U1 was left CONFIRMED by the earlier section — un-confirm specifically
  // for this check, then restore, so both directions are proven for real.
  await db.exec(`update user_profiles set country_confirmed_at=null, country_source=null where user_id='${U1}'`);
  await asTenant(U1, async () => {
    await expectReject('unconfirmed owner cannot UPDATE their own ii_reconciliation_cases row (UPDATE-only authenticated policy, no INSERT — created by service-role, resolved by the owner)', () =>
      db.query(`update ii_reconciliation_cases set status = 'resolved' where id = '${ircId}'`)
    );
  });
  await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${U1}'`);
  await asTenant(U1, async () => {
    await expectOk('once confirmed, the owner CAN update it', () => db.query(`update ii_reconciliation_cases set status = 'resolved' where id = '${ircId}'`));
  });
}

console.log('\n=== (round 2/3) Full-table inventory closure — zero unexplained gaps ===');
{
  const { rows: triggerCount } = await db.query(`
    select count(*)::int c from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal and t.tgname = 'trg_enforce_country_confirmed'
  `);
  check('exactly 85 tables now carry the trg_enforce_country_confirmed backstop (82 generic + 1 bespoke owner-column + 2 bespoke join)', triggerCount[0].c === 85, `(actual: ${triggerCount[0].c})`);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed (${pass + fail} checks) ===`);
process.exit(fail === 0 ? 0 : 1);
