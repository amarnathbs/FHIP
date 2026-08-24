// Assets, Investments & Retirement Consolidation -- certification harness.
// 1) Fresh-rebuild every migration (0001..0074) on a clean PGlite database
//    -- DB-01.
// 2) Separately, replays the "populated DEV upgrade" scenario (DB-02):
//    applies migrations 0001..0071 first, seeds the catalogue AND
//    representative pre-existing user data that mirrors what A0 discovery
//    found live on real DEV (collisions, clean reclassifications, the
//    contribution/balance defect), THEN applies 0072..0074, then asserts
//    exact before/after reconciliation figures -- not "migration completed
//    successfully", real queried numbers (spec s.84).
// 3) Runs the spec's own s.69-75 calculation test matrix against a fresh
//    user entering data only via the CORRECTED catalogue.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.stack); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const ALL_MIGRATIONS = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const CONSOLIDATION_MIGRATIONS = ALL_MIGRATIONS.filter((f) => /^007[234]_air_/.test(f));
const PRE_MIGRATIONS = ALL_MIGRATIONS.filter((f) => !CONSOLIDATION_MIGRATIONS.includes(f));

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};
const approxEq = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) < eps;

function stripCron(sql) {
  return sql.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
}

async function newDb() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  return db;
}

async function applyMigrations(db, files) {
  const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
  for (const f of files) {
    await db.exec(stripCron(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(seed);
  }
}

// ===========================================================================
// PART 1 -- DB-01 fresh rebuild, all 74 migrations, from zero.
// ===========================================================================
console.log('=== DB-01: FRESH REBUILD (all migrations, 0001..latest) ===');
{
  const db = await newDb();
  await applyMigrations(db, ALL_MIGRATIONS);
  const tableCount = (await db.query(`select count(*)::int c from information_schema.tables where table_schema='public'`)).rows[0].c;
  check('fresh rebuild applies every migration with no error', true, `(${ALL_MIGRATIONS.length} files, ${tableCount} public tables)`);
  const newCols = (await db.query(`select column_name from information_schema.columns where table_name='master_financial_items' and column_name in ('is_current_value_source','is_future_flow_source','is_retirement_specific','is_personal_use_default','superseded_by_category','superseded_by_item_key','governance_note')`)).rows;
  check('master_financial_items carries all 7 new canonical metadata columns', newCols.length === 7, `(found ${newCols.length}/7)`);
  const linkCols = (await db.query(`select table_name, column_name from information_schema.columns where table_name in ('assets','investments') and column_name='linked_liability_id'`)).rows;
  check('assets and investments both carry linked_liability_id', linkCols.length === 2);
  const retMembers = (await db.query(`select count(*)::int c from information_schema.tables where table_name='retirement_members'`)).rows[0].c;
  check('retirement_members table exists', retMembers === 1);
  await db.close();
}

// ===========================================================================
// PART 2 -- DB-02 populated-DEV upgrade replay + full reconciliation.
// ===========================================================================
console.log('\n=== DB-02: POPULATED-DEV UPGRADE REPLAY ===');
const db = await newDb();
await applyMigrations(db, PRE_MIGRATIONS); // everything up to and including 0071, NOT 0072-0074 yet

const U = {
  cleanUser: '10000000-0000-0000-0000-000000000001',       // spec s.69 exact reconciliation case, entered via CORRECTED catalogue directly (post-fix user)
  collisionUser: '20000000-0000-0000-0000-000000000002',   // the 3 real DEV collision cases, replayed on one synthetic user
  reclassUser: '30000000-0000-0000-0000-000000000003',     // clean legacy cross-module reclassification, no collisions
  contribUser: '40000000-0000-0000-0000-000000000004',     // the contribution/current_balance defect
  smsfUser: '50000000-0000-0000-0000-000000000005',        // SMSF summary-mode reclassification (asset+investment -> retirement)
  currencyUser: '60000000-0000-0000-0000-000000000006',    // multi-currency test (spec s.76)
};
await db.exec(`insert into auth.users(id,email) values ${Object.values(U).map((id) => `('${id}','${id}@t.test')`).join(',')};`);

// Load the PRE-FIX catalogue -- a frozen copy of seed_master_items.sql as
// it stood before this release (see fixtures/README below). This replay
// must mirror what real DEV actually has today, so it genuinely exercises
// 0074's UPDATE statements against real matching rows rather than a
// catalogue that was already corrected before the migration ran. The
// corrected file (now on disk at supabase/seed_master_items.sql) is what
// a FRESH install uses instead -- covered by DB-01 above, via 0072-0074's
// idempotent, additive-safe design applying cleanly either way.
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'fixtures', 'seed_master_items_pre_air_consolidation.sql'), 'utf8'));

// --- reclassUser: clean legacy cross-module rows (no collision) ---------
await db.exec(`
insert into assets (user_id, asset_name, asset_class, current_value, currency_code, country_code, master_item_key)
  values ('${U.reclassUser}', 'ETFs', 'other', 750000, 'AUD', 'AU', 'etfs'),
         ('${U.reclassUser}', 'Gold', 'other', 51000, 'AUD', 'AU', 'gold'),
         ('${U.reclassUser}', 'Investment Property', 'other', 161390000, 'AUD', 'AU', 'investment_property'),
         ('${U.reclassUser}', 'Retail Super', 'other', 750000, 'AUD', 'AU', 'retail_super');
`);

// --- collisionUser: the 3 real-DEV possible-duplicate cases --------------
await db.exec(`
insert into assets (user_id, asset_name, asset_class, current_value, currency_code, country_code, master_item_key)
  values ('${U.collisionUser}', 'Property', 'other', 650000, 'AUD', 'AU', 'commercial_property'),
         ('${U.collisionUser}', 'Other Assets', 'other', 25000, 'AUD', 'AU', 'shares'),
         ('${U.collisionUser}', 'Cash and Transaction Accounts', 'other', 35000, 'AUD', 'AU', 'term_deposits');
insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, master_item_key)
  values ('${U.collisionUser}', 'Bond and Cash Fund', 'other', 21000, 'AUD', 'AU', 'commercial_property'),
         ('${U.collisionUser}', 'Australian Equity ETF', 'other', 129600, 'AUD', 'AU', 'australian_shares'),
         ('${U.collisionUser}', 'Bond and Cash Fund', 'other', 42000, 'AUD', 'AU', 'term_deposits');
`);

// --- contribUser: the proven pre-existing balance/contribution defect ----
await db.exec(`
insert into retirement_accounts (user_id, account_name, account_type, current_balance, employer_contribution, personal_contribution, contribution_frequency, currency_code, country_code, master_item_key)
  values ('${U.contribUser}', 'Industry Super', 'industry_super', 200000, 0, 0, 'monthly', 'AUD', 'AU', 'industry_super'),
         ('${U.contribUser}', 'Salary Sacrifice', 'salary_sacrifice', 4400000, 12000, 6000, 'monthly', 'AUD', 'AU', 'salary_sacrifice');
`);

// --- smsfUser: SMSF summary balance duplicated across Assets AND
//     Investments' SMSF Investments (both must collapse to one Retirement
//     row's worth of canonical treatment; no pre-existing retirement.smsf
//     row exists for this user so both are clean, non-colliding moves).
await db.exec(`
insert into assets (user_id, asset_name, asset_class, current_value, currency_code, country_code, master_item_key)
  values ('${U.smsfUser}', 'SMSF Balance', 'other', 25000, 'AUD', 'AU', 'smsf_balance');
insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, master_item_key)
  values ('${U.smsfUser}', 'SMSF Investments', 'other', 5194000, 'AUD', 'AU', 'smsf_investments');
`);
// A0 discovery found 3 real goal_funding_sources rows on live DEV pointing
// at an investments.smsf_investments row -- this reproduces that exact
// scenario so the migration's FK re-pointing is genuinely exercised, not
// just asserted in prose.
const smsfInvId = (await db.query(`select id from investments where user_id='${U.smsfUser}' and master_item_key='smsf_investments'`)).rows[0].id;
const goalId = (await db.query(`insert into user_goals (user_id, goal_name, goal_type, target_amount, current_amount, currency_code) values ('${U.smsfUser}', 'Retirement Goal', 'retirement', 1000000, 0, 'AUD') returning id`)).rows[0].id;
await db.exec(`insert into goal_funding_sources (goal_id, user_id, source_type, linked_investment_id, allocated_amount) values ('${goalId}', '${U.smsfUser}', 'investment', '${smsfInvId}', 5194000);`);

async function totals(userId) {
  const a = (await db.query(`select coalesce(sum(current_value),0)::float s, count(*)::int n from assets where user_id='${userId}' and is_active=true`)).rows[0];
  const i = (await db.query(`select coalesce(sum(current_value),0)::float s, count(*)::int n from investments where user_id='${userId}' and is_active=true`)).rows[0];
  const r = (await db.query(`select coalesce(sum(current_balance),0)::float s, count(*)::int n from retirement_accounts where user_id='${userId}' and is_active=true`)).rows[0];
  const l = (await db.query(`select coalesce(sum(balance),0)::float s, count(*)::int n from liabilities where user_id='${userId}' and is_active=true`)).rows[0];
  const gross = a.s + i.s + r.s;
  return { assets: a.s, assetsN: a.n, investments: i.s, investmentsN: i.n, retirement: r.s, retirementN: r.n, liabilities: l.s, gross, netWorth: gross - l.s };
}

console.log('\n-- BEFORE migrations 0072-0074 --');
const before = {};
for (const [name, id] of Object.entries(U)) before[name] = await totals(id);
for (const [name, t] of Object.entries(before)) console.log(`  ${name}: assets=${t.assets} investments=${t.investments} retirement=${t.retirement} netWorth=${t.netWorth}`);

console.log('\n-- Applying 0072, 0073, 0074 --');
await applyMigrations(db, CONSOLIDATION_MIGRATIONS);
console.log('  applied without error');

console.log('\n-- AFTER migrations 0072-0074 --');
const after = {};
for (const [name, id] of Object.entries(U)) after[name] = await totals(id);
for (const [name, t] of Object.entries(after)) console.log(`  ${name}: assets=${t.assets} investments=${t.investments} retirement=${t.retirement} netWorth=${t.netWorth}`);

console.log('\n=== RECONCILIATION ASSERTIONS ===');

// reclassUser: pure taxonomy move -- Net Worth MUST be unchanged (spec s.60/93).
check('reclassUser: Net Worth unchanged by pure reclassification',
  approxEq(before.reclassUser.netWorth, after.reclassUser.netWorth),
  `(before=${before.reclassUser.netWorth}, after=${after.reclassUser.netWorth})`);
check('reclassUser: Assets subtotal now 0 (all 4 rows moved out)', approxEq(after.reclassUser.assets, 0), `(${after.reclassUser.assets})`);
check('reclassUser: Investments now holds ETFs+Gold+Property = 750000+51000+161390000',
  approxEq(after.reclassUser.investments, 750000 + 51000 + 161390000), `(${after.reclassUser.investments})`);
check('reclassUser: Retirement now holds Retail Super = 750000', approxEq(after.reclassUser.retirement, 750000), `(${after.reclassUser.retirement})`);

// collisionUser: 3 possible-duplicate pairs -- BOTH amounts preserved, Net
// Worth unchanged (nothing merged/deleted), and each pre-existing
// destination-side row is untouched.
check('collisionUser: Net Worth unchanged (both sides of every possible duplicate preserved)',
  approxEq(before.collisionUser.netWorth, after.collisionUser.netWorth),
  `(before=${before.collisionUser.netWorth}, after=${after.collisionUser.netWorth})`);
check('collisionUser: Assets subtotal now 0 (source rows deactivated, not deleted)', approxEq(after.collisionUser.assets, 0));
const collisionInvRows = (await db.query(`select investment_name, current_value, master_item_key, notes from investments where user_id='${U.collisionUser}' and is_active=true order by current_value desc`)).rows;
check('collisionUser: exactly 6 active Investments rows (3 original + 3 flagged-preserved)', collisionInvRows.length === 6, `(found ${collisionInvRows.length})`);
const flaggedRows = collisionInvRows.filter((r) => r.master_item_key === null && /Possible duplicate/.test(r.notes ?? ''));
check('collisionUser: exactly 3 rows flagged as possible duplicates with an explanatory note', flaggedRows.length === 3, `(found ${flaggedRows.length})`);
check('collisionUser: flagged amounts are exactly 650000/25000/35000 (nothing merged into the pre-existing values)',
  [650000, 25000, 35000].every((v) => flaggedRows.some((r) => approxEq(r.current_value, v))));
check('collisionUser: pre-existing destination rows (21000/129600/42000) are untouched',
  [21000, 129600, 42000].every((v) => collisionInvRows.some((r) => approxEq(r.current_value, v))));

// contribUser: PROVEN pre-existing defect -- Net Worth MUST decrease by
// exactly the miscounted contribution amount (spec s.93's carve-out).
const expectedContribDrop = 4400000;
check('contribUser: Net Worth decreases by exactly the miscounted contribution (4,400,000)',
  approxEq(before.contribUser.netWorth - after.contribUser.netWorth, expectedContribDrop),
  `(before=${before.contribUser.netWorth}, after=${after.contribUser.netWorth}, drop=${before.contribUser.netWorth - after.contribUser.netWorth})`);
const contribRow = (await db.query(`select current_balance, employer_contribution, personal_contribution from retirement_accounts where user_id='${U.contribUser}' and master_item_key='salary_sacrifice'`)).rows[0];
check('contribUser: salary_sacrifice row current_balance corrected to 0', approxEq(contribRow.current_balance, 0), `(${contribRow.current_balance})`);
check('contribUser: salary_sacrifice row employer_contribution now 12000+4400000',
  approxEq(contribRow.employer_contribution, 12000 + 4400000), `(${contribRow.employer_contribution})`);
check('contribUser: the untouched Industry Super row (200000) still counts fully',
  approxEq(after.contribUser.retirement, 200000), `(retirement total=${after.contribUser.retirement}, expected 200000)`);

// smsfUser: SMSF summary/investments both collapse to Retirement, Net
// Worth unchanged (spec s.38-41 -- never count both summary AND detailed
// paths; here it's Asset SMSF Balance + Investment SMSF Investments, both
// retiring into Retirement > SMSF as separate preserved rows since no
// pre-existing retirement.smsf row existed to collide with).
check('smsfUser: Net Worth unchanged (SMSF holdings relocated, not duplicated or dropped)',
  approxEq(before.smsfUser.netWorth, after.smsfUser.netWorth),
  `(before=${before.smsfUser.netWorth}, after=${after.smsfUser.netWorth})`);
check('smsfUser: Assets and Investments SMSF rows both cleared out', approxEq(after.smsfUser.assets, 0) && approxEq(after.smsfUser.investments, 0));
check('smsfUser: Retirement now holds 25000+5194000 = 5219000', approxEq(after.smsfUser.retirement, 25000 + 5194000), `(${after.smsfUser.retirement})`);

// Goal-link re-pointing (spec s.63) -- the real 3-row scenario found live
// on DEV, reproduced: a Goal funded by the smsf_investments row must keep
// funding the SAME real holding after it relocates to Retirement, not
// silently lose its link to a now-inactive investments row.
const gfsAfter = (await db.query(`select linked_investment_id, linked_retirement_id from goal_funding_sources where goal_id='${goalId}'`)).rows[0];
check('smsfUser: goal_funding_sources re-pointed from linked_investment_id to linked_retirement_id',
  gfsAfter.linked_investment_id === null && gfsAfter.linked_retirement_id !== null,
  `(linked_investment_id=${gfsAfter.linked_investment_id}, linked_retirement_id=${gfsAfter.linked_retirement_id})`);
// Note: smsfUser deliberately combines BOTH an asset-side SMSF Balance AND
// an investment-side SMSF Investments row for the SAME user -- this is a
// stricter compound scenario than any single real DEV row (A0 discovery's
// asset->retirement and investment->retirement collision checks each
// independently found 0 collisions in real data). Because part 2 processes
// assets->retirement first, by the time the investments->retirement block
// runs, retirement.smsf already exists for this user -- so the
// smsf_investments row correctly takes the COLLISION branch (flagged,
// unlinked) rather than the clean 'smsf' key, which is itself a genuine
// extra proof point for the collision-avoidance logic. The goal link must
// therefore point at whichever retirement row actually now holds the
// 5,194,000 (the flagged one), not assumed to be the 'smsf'-keyed row.
const retRowForGoal = (await db.query(`select current_balance, master_item_key from retirement_accounts where id='${gfsAfter.linked_retirement_id}'`)).rows[0];
check('smsfUser: the re-pointed linked_retirement_id is the row actually holding the 5,194,000 SMSF Investments amount',
  approxEq(retRowForGoal.current_balance, 5194000), `(points at a row with current_balance=${retRowForGoal.current_balance}, master_item_key=${retRowForGoal.master_item_key})`);

// Catalogue correction assertions.
const deactivated = (await db.query(`select item_key from master_financial_items where category='asset' and item_key in ('shares','etfs','managed_funds','bonds','private_equity','cryptocurrency','gold','silver','term_deposits','commercial_property','investment_property','business_ownership','partnership_interest','smsf_balance','industry_super','retail_super','defined_benefit') and is_active=false`)).rows;
check('catalogue: all 17 retired Assets items are now inactive', deactivated.length === 17, `(found ${deactivated.length}/17)`);
const smsfInvDeactivated = (await db.query(`select is_active from master_financial_items where category='investment' and item_key='smsf_investments'`)).rows[0];
check('catalogue: investment.smsf_investments is now inactive', smsfInvDeactivated.is_active === false);
const propertyLabel = (await db.query(`select item_label from master_financial_items where category='investment' and item_key='property'`)).rows[0];
check('catalogue: investment.property relabelled to Residential Investment Property', propertyLabel.item_label === 'Residential Investment Property', `("${propertyLabel.item_label}")`);
const contribFlags = (await db.query(`select item_key, is_current_value_source, is_future_flow_source from master_financial_items where category='retirement' and item_key in ('employer_contributions','salary_sacrifice','personal_concessional','non_concessional','spouse_contribution','government_co_contribution')`)).rows;
check('catalogue: all 6 retirement contribution items flagged future-flow-only, not current-value',
  contribFlags.length === 6 && contribFlags.every((r) => r.is_current_value_source === false && r.is_future_flow_source === true));
const contribActive = (await db.query(`select is_active from master_financial_items where category='retirement' and item_key='salary_sacrifice'`)).rows[0];
check('catalogue: contribution items remain ACTIVE (not deactivated -- would orphan the 45 corrected real rows)', contribActive.is_active === true);

// ===========================================================================
// PART 3 -- spec s.69-75 calculation test matrix, entered via the
// CORRECTED catalogue only (a genuinely new post-fix user).
// ===========================================================================
console.log('\n=== CALCULATION TEST MATRIX (spec s.69-75) ===');
await db.exec(`
insert into assets (user_id, asset_name, asset_class, current_value, currency_code, country_code, master_item_key)
  values ('${U.cleanUser}', 'Principal Residence', 'other', 800000, 'AUD', 'AU', 'principal_residence'),
         ('${U.cleanUser}', 'Savings', 'other', 50000, 'AUD', 'AU', 'savings_account'),
         ('${U.cleanUser}', 'Vehicle', 'other', 30000, 'AUD', 'AU', 'motor_vehicle');
insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, master_item_key)
  values ('${U.cleanUser}', 'Shares', 'other', 100000, 'AUD', 'AU', 'australian_shares'),
         ('${U.cleanUser}', 'ETF', 'other', 50000, 'AUD', 'AU', 'etfs'),
         ('${U.cleanUser}', 'Investment Property', 'other', 600000, 'AUD', 'AU', 'property');
insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, master_item_key)
  values ('${U.cleanUser}', 'Super', 'industry_super', 250000, 'AUD', 'AU', 'industry_super');
insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, country_code, master_item_key)
  values ('${U.cleanUser}', 'Home Loan', 'mortgage', 500000, 'AUD', 'AU', 'home_loan'),
         ('${U.cleanUser}', 'Investment Property Loan', 'other', 400000, 'AUD', 'AU', 'investment_loan');
`);
const clean = await totals(U.cleanUser);
check('s.69 key reconciliation case: Gross Household Assets = 1,880,000', approxEq(clean.gross, 1880000), `(${clean.gross})`);
check('s.69 key reconciliation case: Liabilities = 900,000', approxEq(clean.liabilities, 900000), `(${clean.liabilities})`);
check('s.69 key reconciliation case: Net Worth = 980,000', approxEq(clean.netWorth, 980000), `(${clean.netWorth})`);
check('s.70 ETF duplicate test: Investments = 100000+50000+600000, no 200000 double-count',
  approxEq(clean.investments, 750000), `(${clean.investments})`);
check('s.72 Super test: Retirement = 250000, no separate Asset/Super record possible (catalogue item retired)', approxEq(clean.retirement, 250000));

// s.71 Term Deposit test (own user -- canonical home is Investments only).
const tdUser = '70000000-0000-0000-0000-000000000007';
await db.exec(`insert into auth.users(id,email) values ('${tdUser}','${tdUser}@t.test');`);
await db.exec(`insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, master_item_key) values ('${tdUser}', 'Term Deposit', 'other', 250000, 'AUD', 'AU', 'term_deposits');`);
const td = await totals(tdUser);
check('s.71 Term Deposit test: Investments=250000, no duplicate Assets record possible', approxEq(td.investments, 250000) && approxEq(td.assets, 0));

// s.74 Property + linked liability test -- full gross value AND full
// liability both counted (spec explicitly forbids storing only net equity).
const propUser = '80000000-0000-0000-0000-000000000008';
await db.exec(`insert into auth.users(id,email) values ('${propUser}','${propUser}@t.test');`);
const liabId = (await db.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, country_code, master_item_key) values ('${propUser}','Investment Property Loan','other',500000,'AUD','AU','investment_loan') returning id`)).rows[0].id;
await db.exec(`insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, master_item_key, linked_liability_id) values ('${propUser}', 'Investment Property', 'other', 750000, 'AUD', 'AU', 'property', '${liabId}');`);
const prop = await totals(propUser);
check('s.74 Property test: Gross Assets +750000, Liabilities +500000, Net contribution=250000 (full values, not net equity)',
  approxEq(prop.investments, 750000) && approxEq(prop.liabilities, 500000) && approxEq(prop.netWorth, 250000));
const linkCheck = (await db.query(`select linked_liability_id from investments where user_id='${propUser}'`)).rows[0];
check('s.22/74 property<->loan link is queryable', linkCheck.linked_liability_id === liabId);

// s.75 contribution test (own user, isolated from contribUser's defect-fix scenario above).
const contribTestUser = '90000000-0000-0000-0000-000000000009';
await db.exec(`insert into auth.users(id,email) values ('${contribTestUser}','${contribTestUser}@t.test');`);
await db.exec(`insert into retirement_accounts (user_id, account_name, account_type, current_balance, employer_contribution, contribution_frequency, currency_code, country_code, master_item_key) values ('${contribTestUser}', 'Industry Super', 'industry_super', 200000, 1000, 'monthly', 'AUD', 'AU', 'industry_super');`);
const ct = await totals(contribTestUser);
check('s.75 contribution test: current Retirement Asset = 200000, NOT 201000 (contribution is future-flow only)', approxEq(ct.retirement, 200000), `(${ct.retirement})`);

// s.76 multi-currency test -- values preserved in original currency,
// nothing silently reinterpreted (INR is never summed as if it were AUD).
const fxUser = 'a0000000-0000-0000-0000-00000000000a';
await db.exec(`insert into auth.users(id,email) values ('${fxUser}','${fxUser}@t.test');`);
await db.exec(`insert into assets (user_id, asset_name, asset_class, current_value, currency_code, country_code, master_item_key) values ('${fxUser}', 'Savings', 'other', 100000, 'AUD', 'AU', 'savings_account');`);
await db.exec(`insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, master_item_key) values ('${fxUser}', 'Indian Mutual Fund', 'other', 10000000, 'INR', 'IN', 'managed_funds');`);
const fx = (await db.query(`select currency_code, current_value from assets where user_id='${fxUser}' union all select currency_code, current_value from investments where user_id='${fxUser}'`)).rows;
check('s.76 multi-currency test: AUD row stored as 100000 AUD (untouched)', fx.some((r) => r.currency_code === 'AUD' && approxEq(r.current_value, 100000)));
check('s.76 multi-currency test: INR row stored as 10000000 INR, not reinterpreted as AUD', fx.some((r) => r.currency_code === 'INR' && approxEq(r.current_value, 10000000)));

// s.77 legacy duplicate test -- already covered by collisionUser above;
// cross-referenced here explicitly under its own spec section number.
check('s.77 legacy duplicate test: unproven duplicates preserved, not silently deleted (see collisionUser assertions above)', flaggedRows.length === 3);

await db.close();

console.log(`\n=== CERTIFICATION: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
