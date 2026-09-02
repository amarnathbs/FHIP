// G3 — Registration and Existing-User Alignment: database-layer certification
// against a FRESHLY REBUILT database (every migration 0001..0127 replayed in
// order), using the same PGlite + asTenant()/asService() harness as rls.mjs
// and smsf_jurisdiction_cert.mjs.
//
// Everything asserted here is asserted against REAL PostgreSQL semantics —
// real triggers firing, real RLS, real CHECK constraints, real FKs. This is
// the half of G3's certification a mocked Supabase client fundamentally
// cannot prove; tests/unit/g3RegistrationAlignment.test.ts covers the
// application-layer half.
//
// The central claim under test is G3's two-tier model:
//
//   TIER 2 (unchanged)  is_country_confirmed()  -> requires is_supported
//                       -> AU/IN only -> guards the ~85 financial tables
//   TIER 1 (new)        is_country_registration_confirmed() -> registry only
//                       -> all six -> guards exactly two non-financial tables
//
// If that model is right, a confirmed GB user can declare a cross-border
// relationship and can NOT insert a single financial row. Both halves are
// proven below with real writes, not by reading the SQL.
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
const migrationFiles = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
for (const f of migrationFiles) {
  await db.exec(
    fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '')
  );
  if (f.startsWith('0001')) await db.exec(seed);
}
await db.exec(fs.readFileSync(path.join(ROOT, 'seed_master_items.sql'), 'utf8'));
console.log(`fresh rebuild complete — ${migrationFiles.length} migrations replayed in order\n`);

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};
async function expectReject(label, fn, expectContains) {
  try {
    await fn();
    check(label, false, '(expected rejection, but the write SUCCEEDED)');
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (expectContains && !msg.includes(expectContains)) {
      check(label, false, `(rejected, but with the wrong error: ${msg.slice(0, 140)})`);
    } else {
      check(label, true, `(rejected: ${msg.split('\n')[0].slice(0, 100)})`);
    }
  }
}
async function expectAccept(label, fn) {
  try { await fn(); check(label, true); }
  catch (e) { check(label, false, `(expected success, got: ${String(e?.message ?? e).split('\n')[0].slice(0, 140)})`); }
}

async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  const seen = (await db.query(`select auth.uid()::text u`)).rows[0].u;
  if (seen !== uid) { console.log(`  FAIL  harness: auth.uid() is ${seen}, expected ${uid}`); fail++; }
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
async function asService(fn) {
  await db.exec(`set role service_role;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}

// ---------------------------------------------------------------------------
// Fixtures. Deliberately created BEFORE any assertion so the "existing user
// preservation" section can compare a genuine before/after.
// ---------------------------------------------------------------------------
const AU = '11111111-1111-1111-1111-111111111111'; // existing FULL user, AUD
const IN = '22222222-2222-2222-2222-222222222222'; // existing FULL user, INR
const GB = '33333333-3333-3333-3333-333333333333'; // new GENERIC user
const US = '44444444-4444-4444-4444-444444444444'; // new GENERIC user
const SG = '55555555-5555-5555-5555-555555555555'; // new GENERIC user
const AE = '66666666-6666-6666-6666-666666666666'; // new GENERIC user
const UNCONF = '77777777-7777-7777-7777-777777777777'; // never confirmed

await db.exec(`
  insert into auth.users(id,email) values
    ('${AU}','au@t.test'),('${IN}','in@t.test'),('${GB}','gb@t.test'),
    ('${US}','us@t.test'),('${SG}','sg@t.test'),('${AE}','ae@t.test'),
    ('${UNCONF}','unconf@t.test');
`);

// The two pre-existing FULL users, exactly as MCC left them.
await db.exec(`
  update user_profiles set full_name='Existing AU', country_of_residence='AU', preferred_currency='AUD',
    onboarding_completed=true, country_confirmed_at='2026-01-01T00:00:00Z', country_source='USER_CONFIRMED'
    where user_id='${AU}';
  update user_profiles set full_name='Existing IN', country_of_residence='IN', preferred_currency='INR',
    onboarding_completed=true, country_confirmed_at='2026-01-01T00:00:00Z', country_source='USER_CONFIRMED'
    where user_id='${IN}';
  update user_profiles set full_name='Unconfirmed', onboarding_completed=true where user_id='${UNCONF}';
`);

// Give the existing AU user a real financial row so "zero data variance" is a
// claim about actual data, not about an empty table.
await asService(async () => {
  await db.exec(`
    insert into income_sources(user_id, source_name, income_type, amount, frequency, currency_code, is_active)
    values ('${AU}', 'Pre-existing salary', 'salary', 8000, 'monthly', 'AUD', true);
  `);
});

const beforeSnapshot = (
  await db.query(`
    select user_id::text, country_of_residence, country_confirmed_at, country_source,
           preferred_currency, primary_country, primary_country_source, billing_country,
           billing_country_confirmed_at, generic_disclosure_version
    from user_profiles where user_id in ('${AU}','${IN}') order by user_id
  `)
).rows;
const beforeIncome = (await db.query(`select id::text, amount, currency_code from income_sources where user_id='${AU}'`)).rows;

// ===========================================================================
console.log('--- 1. Registry state after migration 0127 ---');
// ===========================================================================
{
  const rows = (await db.query(`
    select c.country_code, c.experience_level, c.is_supported, c.active, c.selectable,
           coalesce(cc.enabled,false) as registration
    from countries c
    left join country_capabilities cc on cc.country_code=c.country_code and cc.capability='REGISTRATION'
    order by c.country_code
  `)).rows;
  const byCode = Object.fromEntries(rows.map((r) => [r.country_code.trim(), r]));

  check('exactly six countries exist in the registry', rows.length === 6, `(found ${rows.length}: ${rows.map(r=>r.country_code.trim()).join(',')})`);
  for (const c of ['AU', 'IN', 'GB', 'US', 'SG', 'AE']) {
    check(`${c} permits REGISTRATION`, byCode[c]?.registration === true);
  }
  check('AU is FULL', byCode.AU?.experience_level === 'FULL');
  check('IN is FULL', byCode.IN?.experience_level === 'FULL');
  for (const c of ['GB', 'US', 'SG', 'AE']) {
    check(`${c} is GENERIC`, byCode[c]?.experience_level === 'GENERIC');
  }
  // THE load-bearing assertion of the whole two-tier design.
  check('is_supported remains TRUE for AU/IN only', byCode.AU?.is_supported === true && byCode.IN?.is_supported === true);
  for (const c of ['GB', 'US', 'SG', 'AE']) {
    check(`${c} is_supported remains FALSE (financial backstop unchanged)`, byCode[c]?.is_supported === false);
  }

  // Non-registration capabilities must be exactly as G1 left them.
  const domestic = (await db.query(`
    select country_code, capability, enabled from country_capabilities
    where capability in ('DOMESTIC_CALCULATIONS','DOMESTIC_RETIREMENT','DOMESTIC_TAX_OUTPUTS','APPROVED_BILLING','APPROVED_PRICING','FX_CONVERSION','REGULATORY_GUIDANCE')
      and country_code in ('GB','US','SG','AE') and enabled
  `)).rows;
  check('no GENERIC country has any domestic/billing/pricing/FX capability enabled', domestic.length === 0, `(found ${domestic.length})`);

  const approvedBilling = (await db.query(`select count(*)::int n from country_capabilities where capability='APPROVED_BILLING' and enabled`)).rows[0].n;
  check('APPROVED_BILLING remains disabled for every country', approvedBilling === 0);
}

// ===========================================================================
console.log('\n--- 2. GLOBAL and catch-all pseudo-countries cannot be stored ---');
// ===========================================================================
await asService(async () => {
  await expectReject("a 'GLOBAL' country row is impossible (char(2))", () =>
    db.exec(`insert into countries(country_code,country_name,default_currency_code) values ('GLOBAL','Global','AUD')`)
  );
  for (const placeholder of ['XX', 'ZZ', 'AA', 'QQ']) {
    await expectReject(`a '${placeholder}' catch-all country row is rejected by the new constraint`, () =>
      db.exec(`insert into countries(country_code,country_name,default_currency_code) values ('${placeholder}','Rest of world','AUD')`),
      'countries_country_code_is_real_iso_check'
    );
  }
  await expectReject('a lowercase country code is rejected', () =>
    db.exec(`insert into countries(country_code,country_name,default_currency_code) values ('gl','lowercase','AUD')`)
  );
});
await asTenant(GB, async () => {
  await expectReject("an authenticated client cannot write 'GLOBAL' into country_of_residence", () =>
    db.exec(`update user_profiles set country_of_residence='GLOBAL' where user_id='${GB}'`)
  );
});

// ===========================================================================
console.log('\n--- 3. A GENERIC country cannot be confirmed without the disclosure ---');
// ===========================================================================
await asTenant(GB, async () => {
  // The forged-confirmation attack: a direct PostgREST-style write that skips
  // the confirm route entirely.
  await expectReject('forged GB confirmation with NO acknowledgement is rejected', () =>
    db.exec(`update user_profiles set country_of_residence='GB', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${GB}'`),
    'GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED'
  );
  // An acknowledgement recorded for a DIFFERENT country must not carry across.
  await expectReject('an acknowledgement recorded for US cannot confirm GB', () =>
    db.exec(`update user_profiles set country_of_residence='GB', country_confirmed_at=now(), country_source='USER_CONFIRMED',
             generic_disclosure_version='g3-generic-coverage-2026-09', generic_disclosure_acknowledged_at=now(),
             generic_disclosure_country='US' where user_id='${GB}'`),
    'GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED'
  );
  // A partial acknowledgement is not an acknowledgement.
  await expectReject('a timestamp with no version fails the completeness CHECK', () =>
    db.exec(`update user_profiles set generic_disclosure_acknowledged_at=now() where user_id='${GB}'`),
    'user_profiles_generic_disclosure_complete_check'
  );
  // The legitimate path.
  await expectAccept('GB confirms successfully WITH a matching acknowledgement', () =>
    db.exec(`update user_profiles set country_of_residence='GB', country_confirmed_at=now(), country_source='USER_CONFIRMED',
             onboarding_completed=true, preferred_currency='AUD',
             generic_disclosure_version='g3-generic-coverage-2026-09', generic_disclosure_acknowledged_at=now(),
             generic_disclosure_country='GB' where user_id='${GB}'`)
  );
});
// Service role is deliberately NOT exempt from this one.
await asService(async () => {
  await expectReject('even service_role cannot confirm a GENERIC country without the disclosure', () =>
    db.exec(`update user_profiles set country_of_residence='US', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${US}'`),
    'GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED'
  );
});

// Set up the remaining generic users properly.
await asService(async () => {
  for (const [uid, code, ccy] of [[US, 'US', 'AUD'], [SG, 'SG', 'INR'], [AE, 'AE', 'AUD']]) {
    await db.exec(`update user_profiles set country_of_residence='${code}', country_confirmed_at=now(),
      country_source='USER_CONFIRMED', onboarding_completed=true, preferred_currency='${ccy}',
      generic_disclosure_version='g3-generic-coverage-2026-09', generic_disclosure_acknowledged_at=now(),
      generic_disclosure_country='${code}' where user_id='${uid}';`);
  }
});
{
  const n = (await db.query(`select count(*)::int n from user_profiles where country_confirmed_at is not null and country_of_residence in ('GB','US','SG','AE')`)).rows[0].n;
  check('all four GENERIC countries can now be confirmed (G3-05..G3-09)', n === 4, `(confirmed: ${n}/4)`);
}
// A FULL country needs no acknowledgement — the trigger must not over-reach.
await asTenant(AU, async () => {
  await expectAccept('a FULL country still confirms with NO acknowledgement (no regression)', () =>
    db.exec(`update user_profiles set country_confirmed_at=now() where user_id='${AU}'`)
  );
});

// ===========================================================================
console.log('\n--- 4. The two-tier predicate split ---');
// ===========================================================================
{
  const r = (await db.query(`
    select
      public.is_country_confirmed('${AU}') au_fin,
      public.is_country_registration_confirmed('${AU}') au_reg,
      public.is_country_confirmed('${GB}') gb_fin,
      public.is_country_registration_confirmed('${GB}') gb_reg,
      public.is_country_confirmed('${UNCONF}') un_fin,
      public.is_country_registration_confirmed('${UNCONF}') un_reg
  `)).rows[0];
  check('AU passes BOTH tiers', r.au_fin === true && r.au_reg === true);
  check('GB passes TIER 1 (registration) but NOT TIER 2 (financial)', r.gb_reg === true && r.gb_fin === false);
  check('an unconfirmed user passes NEITHER tier', r.un_fin === false && r.un_reg === false);

  const elig = (await db.query(`
    select public.is_country_registration_eligible('GB') gb,
           public.is_country_registration_eligible('AU') au,
           public.is_country_registration_eligible('NZ') nz
  `)).rows[0];
  check('registration eligibility is true for GB and AU, false for an unoffered country', elig.gb === true && elig.au === true && elig.nz === false);
}

// ===========================================================================
console.log('\n--- 5. Interim G4 boundary: a GENERIC user cannot hold financial data ---');
// ===========================================================================
// Every column these INSERTs name is NOT NULL in the real schema (0001/0003),
// so a rejection can only ever be the country gate — never a missing-column
// error masquerading as one. The AU positive control below proves exactly
// that: the identical statements SUCCEED for a FULL-experience user.
const FINANCIAL_WRITES = [
  ['income_sources', `insert into income_sources(user_id,source_name,income_type,amount,frequency,currency_code,is_active) values ($UID,'Salary','salary',5000,'monthly','AUD',true)`],
  ['expense_items', `insert into expense_items(user_id,expense_name,expense_category,amount,frequency,currency_code,is_active) values ($UID,'Groceries','food',500,'monthly','AUD',true)`],
  ['assets', `insert into assets(user_id,asset_name,asset_class,current_value,currency_code,is_active) values ($UID,'Savings','cash',1000,'AUD',true)`],
  ['liabilities', `insert into liabilities(user_id,liability_name,debt_type,balance,currency_code,is_active) values ($UID,'Loan','personal_loan',1000,'AUD',true)`],
  ['investments', `insert into investments(user_id,investment_name,investment_type,current_value,currency_code,is_active) values ($UID,'Shares','shares',1000,'AUD',true)`],
  ['retirement_accounts', `insert into retirement_accounts(user_id,account_name,account_type,current_balance,currency_code,is_active) values ($UID,'Super','super',1000,'AUD',true)`],
  ['insurance_policies', `insert into insurance_policies(user_id,policy_name,cover_type,cover_amount,premium,premium_frequency,currency_code,is_active) values ($UID,'Life','life',100000,50,'monthly','AUD',true)`],
  ['user_goals', `insert into user_goals(user_id,goal_name,goal_type,target_amount,currency_code) values ($UID,'Goal','starter_emergency_fund',1000,'AUD')`],
];
for (const [uid, label] of [[GB, 'GB'], [US, 'US'], [SG, 'SG'], [AE, 'AE']]) {
  await asTenant(uid, async () => {
    for (const [table, sql] of FINANCIAL_WRITES) {
      await expectReject(`${label} user cannot insert into ${table}`, () => db.exec(sql.replaceAll('$UID', `'${uid}'`)),
        'COUNTRY_CONFIRMATION_REQUIRED');
    }
  });
}
// The positive control that proves the above is a real gate, not a broken fixture.
await asTenant(AU, async () => {
  for (const [table, sql] of FINANCIAL_WRITES) {
    await expectAccept(`POSITIVE CONTROL: AU user CAN insert into ${table}`, () => db.exec(sql.replaceAll('$UID', `'${AU}'`)));
  }
});

// SMSF specifically (spec section 14: "A generic user cannot access SMSF").
await asTenant(GB, async () => {
  await expectReject('GB user cannot create an SMSF retirement account', () =>
    db.exec(`insert into retirement_accounts(user_id,account_name,account_type,master_item_key,current_balance,currency_code,is_active) values ('${GB}','SMSF','smsf','smsf',1000,'AUD',true)`)
  );
});

// ===========================================================================
console.log('\n--- 6. Cross-border declarations (section 9) ---');
// ===========================================================================
await asTenant(GB, async () => {
  await expectAccept('GB user CAN declare a cross-border relationship (G3-21)', () =>
    db.exec(`insert into cross_border_relationships(user_id,country_code,relationship_type) values ('${GB}','IN','ASSET')`)
  );
  await expectReject('GB user cannot declare a relationship with their OWN residence country', () =>
    db.exec(`insert into cross_border_relationships(user_id,country_code,relationship_type) values ('${GB}','GB','ASSET')`),
    'CROSS_BORDER_COUNTRY_IS_RESIDENCE'
  );
  await expectReject('GB user cannot declare a relationship with an unoffered country', () =>
    db.exec(`insert into cross_border_relationships(user_id,country_code,relationship_type) values ('${GB}','NZ','ASSET')`)
  );
  await expectReject('a duplicate ACTIVE relationship is refused (one-active constraint preserved)', () =>
    db.exec(`insert into cross_border_relationships(user_id,country_code,relationship_type) values ('${GB}','IN','ASSET')`)
  );
  await expectReject('cross-tenant forged ownership is rejected (G3-24)', () =>
    db.exec(`insert into cross_border_relationships(user_id,country_code,relationship_type) values ('${AU}','IN','ASSET')`)
  );
});
await asTenant(AU, async () => {
  await expectAccept('AU user can declare an IN relationship (G3-23)', () =>
    db.exec(`insert into cross_border_relationships(user_id,country_code,relationship_type) values ('${AU}','IN','INVESTMENT')`)
  );
  const seen = (await db.query(`select count(*)::int n from cross_border_relationships`)).rows[0].n;
  check("AU user cannot READ another tenant's declarations (RLS)", seen === 1, `(saw ${seen} rows, expected only their own 1)`);
});
await asTenant(IN, async () => {
  await expectAccept('IN user can declare an AU relationship (G3-22)', () =>
    db.exec(`insert into cross_border_relationships(user_id,country_code,relationship_type) values ('${IN}','AU','RETIREMENT')`)
  );
});
// Declaring a relationship must change nothing authoritative.
{
  const after = (await db.query(`
    select country_of_residence, preferred_currency, primary_country, billing_country, billing_country_confirmed_at
    from user_profiles where user_id='${GB}'
  `)).rows[0];
  check('declaring a relationship left country_of_residence unchanged', after.country_of_residence.trim() === 'GB');
  check('declaring a relationship left preferred_currency unchanged', after.preferred_currency.trim() === 'AUD');
  check('declaring a relationship confirmed no billing country', after.billing_country === null && after.billing_country_confirmed_at === null);
}
// An unconfirmed user still cannot declare anything.
await asTenant(UNCONF, async () => {
  await expectReject('an unconfirmed user cannot declare a cross-border relationship', () =>
    db.exec(`insert into cross_border_relationships(user_id,country_code,relationship_type) values ('${UNCONF}','IN','ASSET')`),
    'COUNTRY_CONFIRMATION_REQUIRED'
  );
});

// ===========================================================================
console.log('\n--- 7. Currency independence (section 8) ---');
// ===========================================================================
await asTenant(AU, async () => {
  await expectAccept('an AU user may report in INR (G3-02)', () =>
    db.exec(`update user_profiles set preferred_currency='INR' where user_id='${AU}'`)
  );
  const r = (await db.query(`select country_of_residence, country_confirmed_at, primary_country, billing_country from user_profiles where user_id='${AU}'`)).rows[0];
  check('changing currency did not change residence', r.country_of_residence.trim() === 'AU');
  check('changing currency did not un-confirm the country', r.country_confirmed_at !== null);
  check('changing currency did not change primary country', r.primary_country === null || r.primary_country.trim() === 'AU');
  check('changing currency did not confirm a billing country', r.billing_country === null);
  await db.exec(`update user_profiles set preferred_currency='AUD' where user_id='${AU}'`); // restore
});
await asTenant(GB, async () => {
  await expectAccept('a GB user may report in INR (G3-06)', () =>
    db.exec(`update user_profiles set preferred_currency='INR' where user_id='${GB}'`)
  );
  const r = (await db.query(`select country_of_residence from user_profiles where user_id='${GB}'`)).rows[0];
  check('a GB user reporting in INR is still resident in GB', r.country_of_residence.trim() === 'GB');
  await db.exec(`update user_profiles set preferred_currency='AUD' where user_id='${GB}'`); // restore
});
// G3 finding: the FK to `currencies` STOPPED being sufficient the moment G1
// seeded GBP/USD/SGD/AED as reference rows. Migration 0127 adds the explicit
// AUD/INR CHECK; these four probes are the proof that it works, and the
// reason it had to exist (this exact write succeeded before the constraint).
await asTenant(GB, async () => {
  for (const forged of ['USD', 'GBP', 'SGD', 'AED']) {
    await expectReject(`a forged ${forged} reporting currency is refused at the database layer (G3-16)`, () =>
      db.exec(`update user_profiles set preferred_currency='${forged}' where user_id='${GB}'`),
      'user_profiles_preferred_currency_supported_check'
    );
  }
});
await asTenant(AU, async () => {
  await expectReject('a forged USD reporting currency is refused for a FULL user too (G3-17)', () =>
    db.exec(`update user_profiles set preferred_currency='USD' where user_id='${AU}'`),
    'user_profiles_preferred_currency_supported_check'
  );
});

// ===========================================================================
console.log('\n--- 8. Billing country remains unconfirmable in G3 ---');
// ===========================================================================
await asTenant(GB, async () => {
  await expectReject('a client cannot write billing_country directly (G1 controlled-column guard intact)', () =>
    db.exec(`update user_profiles set billing_country='GB', billing_country_confirmed_at=now(), billing_country_source='USER_CONFIRMED' where user_id='${GB}'`),
    'PRIMARY_OR_BILLING_COUNTRY_REQUIRES_CONTROLLED_WORKFLOW'
  );
  await expectReject('a client cannot write primary_country directly', () =>
    db.exec(`update user_profiles set primary_country='IN' where user_id='${GB}'`),
    'PRIMARY_OR_BILLING_COUNTRY_REQUIRES_CONTROLLED_WORKFLOW'
  );
});
{
  const n = (await db.query(`select count(*)::int n from user_profiles where billing_country is not null or billing_country_confirmed_at is not null`)).rows[0].n;
  check('no user anywhere has a confirmed billing country after G3', n === 0, `(found ${n})`);
}

// ===========================================================================
console.log('\n--- 9. Existing-user preservation (section 11) ---');
// ===========================================================================
{
  const after = (
    await db.query(`
      select user_id::text, country_of_residence, country_confirmed_at, country_source,
             preferred_currency, primary_country, primary_country_source, billing_country,
             billing_country_confirmed_at, generic_disclosure_version
      from user_profiles where user_id in ('${AU}','${IN}') order by user_id
    `)
  ).rows;
  // country_confirmed_at for AU was deliberately re-stamped in section 3's
  // no-regression check, so compare every field EXCEPT that one.
  const strip = (r) => { const { country_confirmed_at, ...rest } = r; return rest; };
  check(
    'existing AU/IN profiles are otherwise byte-identical before and after G3',
    JSON.stringify(beforeSnapshot.map(strip)) === JSON.stringify(after.map(strip)),
    ''
  );
  check('no existing AU/IN user acquired a generic disclosure record',
    after.every((r) => r.generic_disclosure_version === null));
  check('no existing AU/IN user had preferred_currency rewritten',
    after.find((r) => r.user_id === AU).preferred_currency.trim() === 'AUD' &&
    after.find((r) => r.user_id === IN).preferred_currency.trim() === 'INR');

  const afterIncome = (await db.query(`select id::text, amount, currency_code from income_sources where user_id='${AU}' and amount=8000`)).rows;
  check('the pre-existing financial row is untouched (amount + original currency)',
    afterIncome.length === 1 && String(afterIncome[0].amount) === String(beforeIncome[0].amount) &&
    afterIncome[0].currency_code === beforeIncome[0].currency_code);
}

// Aggregate audit (section 11.1) — counts only, no personal identifiers.
{
  const agg = (await db.query(`
    select
      count(*) filter (where country_of_residence='AU' and country_confirmed_at is not null)::int au_confirmed,
      count(*) filter (where country_of_residence='IN' and country_confirmed_at is not null)::int in_confirmed,
      count(*) filter (where country_of_residence in ('GB','US','SG','AE') and country_confirmed_at is not null)::int generic_confirmed,
      count(*) filter (where country_of_residence is null)::int missing,
      count(*) filter (where country_of_residence is not null and country_of_residence not in ('AU','IN','GB','US','SG','AE'))::int invalid,
      count(*) filter (where preferred_currency='AUD')::int aud,
      count(*) filter (where preferred_currency='INR')::int inr,
      count(*) filter (where billing_country is not null)::int billing
    from user_profiles
  `)).rows[0];
  console.log(`  INFO  aggregate profile audit: ${JSON.stringify(agg)}`);
  check('zero invalid country values exist after G3', agg.invalid === 0);
  check('zero billing countries confirmed', agg.billing === 0);
}

// ===========================================================================
console.log('\n--- 10. MCC regression: nothing about the original gate changed ---');
// ===========================================================================
await asTenant(UNCONF, async () => {
  for (const [table, sql] of FINANCIAL_WRITES) {
    await expectReject(`unconfirmed user still blocked from ${table} (MCC unchanged)`, () =>
      db.exec(sql.replaceAll('$UID', `'${UNCONF}'`)), 'COUNTRY_CONFIRMATION_REQUIRED');
  }
});
{
  // MCC-14: the account-deletion cascade exemption must still work on the
  // repointed cross_border_relationships trigger.
  const TMP = '88888888-8888-8888-8888-888888888888';
  await db.exec(`insert into auth.users(id,email) values ('${TMP}','tmp@t.test');`);
  await asService(async () => {
    await db.exec(`update user_profiles set country_of_residence='GB', country_confirmed_at=now(), country_source='USER_CONFIRMED',
      onboarding_completed=true, generic_disclosure_version='g3-generic-coverage-2026-09',
      generic_disclosure_acknowledged_at=now(), generic_disclosure_country='GB' where user_id='${TMP}';`);
    await db.exec(`insert into cross_border_relationships(user_id,country_code,relationship_type) values ('${TMP}','IN','TAX');`);
  });
  await expectAccept('MCC-14: deleting the auth.users row cascades cleanly through cross_border_relationships', () =>
    db.exec(`delete from auth.users where id='${TMP}'`)
  );
  const left = (await db.query(`select count(*)::int n from cross_border_relationships where user_id='${TMP}'`)).rows[0].n;
  check('the cascade left no orphaned cross-border rows', left === 0);
}

// ===========================================================================
console.log('\n--- 11. RLS coverage on every G3-touched object ---');
// ===========================================================================
{
  const rls = (await db.query(`
    select relname, relrowsecurity from pg_class
    where relname in ('cross_border_relationships','country_change_previews','country_capabilities','countries','user_profiles')
      and relkind='r'
  `)).rows;
  for (const r of rls) {
    check(`RLS enabled on ${r.relname}`, r.relrowsecurity === true);
  }
  // No new user-owned table was introduced by G3 (the disclosure lives as
  // columns on an already-protected row), so there is no new RLS surface.
  check('G3 introduced no new user-owned table (disclosure stored as user_profiles columns)',
    (await db.query(`select count(*)::int n from information_schema.tables where table_schema='public' and table_name like 'generic_disclosure%'`)).rows[0].n === 0);
}

// ===========================================================================
console.log(`\n=== G3 database certification: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
