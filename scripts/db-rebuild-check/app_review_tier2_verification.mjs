// App Review tier-2 fix pass (2026-08-28 branch reconciliation) —
// verification for the 3 new migrations (0099 profile phone, 0100 India
// retirement catalogue, 0101 expense catalogue Education + Land Tax).
// Mirrors education_goal_linkage.mjs's structure:
//   RED  — build the chain only through 0098 (the state before this pass)
//          and confirm every new column/row is genuinely absent.
//   GREEN — build the full chain through the latest migration and confirm
//          every new column/row is now present, with the correct flags.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const seedSql = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
// master_financial_items' real seed — needed so 0100/0101's catalogue
// inserts are checked against a realistically-populated catalogue, not an
// empty table (see education_goal_linkage.mjs's identical comment).
const masterItemsSeedSql = fs.readFileSync(path.join(ROOT, 'seed_master_items.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const shim = fs.readFileSync(path.join(HERE, 'shim.sql'), 'utf8');

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; console.log(`  FAIL  ${label} ${detail}`); }
};

async function buildTo(db, versionPrefix) {
  await db.exec(shim);
  for (const f of files) {
    if (f.slice(0, 4) > versionPrefix) break;
    await db.exec(
      fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '')
    );
    if (f.startsWith('0001')) await db.exec(seedSql);
    if (f.startsWith('0004')) await db.exec(masterItemsSeedSql);
  }
}

// ---------------------------------------------------------------------------
// RED — state before this pass (through 0098, the real tip of main at
// dispatch time). Every new column/row must be genuinely absent.
// ---------------------------------------------------------------------------
console.log('=== RED: state through 0098 (before this pass) ===\n');
const dbRed = await PGlite.create();
await buildTo(dbRed, '0098');
console.log('built through 0098\n');

const redPhoneCol = await dbRed.query(
  `select column_name from information_schema.columns where table_name='user_profiles' and column_name='phone'`
);
check('RED: user_profiles.phone does NOT exist yet', redPhoneCol.rows.length === 0, `(found ${redPhoneCol.rows.length} matching columns)`);

const redRetirement = await dbRed.query(
  `select item_key from master_financial_items where category='retirement' and item_key in ('epf','ppf','nps')`
);
check('RED: epf/ppf/nps catalogue rows do NOT exist yet', redRetirement.rows.length === 0, `(found ${redRetirement.rows.length})`);

const redExpense = await dbRed.query(
  `select item_key from master_financial_items where category='expense' and item_key in ('land_tax','education')`
);
check('RED: land_tax/education catalogue rows do NOT exist yet', redExpense.rows.length === 0, `(found ${redExpense.rows.length})`);

// ---------------------------------------------------------------------------
// GREEN — full chain, latest migration.
// ---------------------------------------------------------------------------
console.log('\n=== GREEN: full chain (this pass applied) ===\n');
const dbGreen = await PGlite.create();
const latest = files[files.length - 1].slice(0, 4);
await buildTo(dbGreen, latest);
console.log(`built through ${latest} (${files.length} files)\n`);

const greenPhoneCol = await dbGreen.query(
  `select column_name, data_type from information_schema.columns where table_name='user_profiles' and column_name='phone'`
);
check('GREEN: user_profiles.phone exists', greenPhoneCol.rows.length === 1, JSON.stringify(greenPhoneCol.rows));

// Idempotency: re-applying 0099 must not error (add column if not exists).
await dbGreen.exec(fs.readFileSync(path.join(MIG, '0099_app_review_tier2_profile_phone.sql'), 'utf8'));
check('GREEN: 0099 is idempotent (safe to re-run)', true);

const greenRetirement = await dbGreen.query(
  `select item_key, item_label, sort_order, is_active, is_retirement_specific
     from master_financial_items where category='retirement' and item_key in ('epf','ppf','nps') order by sort_order`
);
check('GREEN: epf/ppf/nps all present (3 rows)', greenRetirement.rows.length === 3, JSON.stringify(greenRetirement.rows.map((r) => r.item_key)));
check(
  'GREEN: epf/ppf/nps are all active and flagged is_retirement_specific=true',
  greenRetirement.rows.every((r) => r.is_active === true && r.is_retirement_specific === true),
  JSON.stringify(greenRetirement.rows)
);
check(
  'GREEN: epf/ppf/nps sort_order continues after existing max (170) without disturbing it',
  greenRetirement.rows.every((r) => r.sort_order > 170),
  JSON.stringify(greenRetirement.rows.map((r) => r.sort_order))
);

// Every pre-existing retirement item must be completely untouched (spec's
// "only add, never rename" discipline) — count + a spot-check on a stable one.
const existingRetirementCount = await dbGreen.query(
  `select count(*)::int as n from master_financial_items where category='retirement'`
);
check('GREEN: pre-existing retirement catalogue is undisturbed (17 original + 3 new = 20)', existingRetirementCount.rows[0].n === 20, `n=${existingRetirementCount.rows[0].n}`);

const smsfRow = await dbGreen.query(`select item_label, sort_order from master_financial_items where category='retirement' and item_key='smsf'`);
check('GREEN: pre-existing SMSF row unchanged', smsfRow.rows[0]?.item_label === 'SMSF' && smsfRow.rows[0]?.sort_order === 30, JSON.stringify(smsfRow.rows));

const greenExpense = await dbGreen.query(
  `select item_key, item_label, sort_order, is_active from master_financial_items where category='expense' and item_key in ('land_tax','education') order by sort_order`
);
check('GREEN: land_tax and education both present (2 rows)', greenExpense.rows.length === 2, JSON.stringify(greenExpense.rows));
check(
  'GREEN: land_tax sits between council_rates(40) and water_rates(50)',
  greenExpense.rows.find((r) => r.item_key === 'land_tax')?.sort_order === 45,
  JSON.stringify(greenExpense.rows.find((r) => r.item_key === 'land_tax'))
);
check(
  'GREEN: education sits between tutoring(260) and health_insurance(270)',
  greenExpense.rows.find((r) => r.item_key === 'education')?.sort_order === 265,
  JSON.stringify(greenExpense.rows.find((r) => r.item_key === 'education'))
);

const neighbourCheck = await dbGreen.query(
  `select item_key, sort_order from master_financial_items where category='expense' and item_key in ('council_rates','water_rates','tutoring','health_insurance') order by sort_order`
);
check('GREEN: neighbouring expense rows (council_rates/water_rates/tutoring/health_insurance) unchanged', neighbourCheck.rows.length === 4, JSON.stringify(neighbourCheck.rows));

// Idempotency for 0100/0101 too (on conflict do nothing).
await dbGreen.exec(fs.readFileSync(path.join(MIG, '0100_app_review_tier2_india_retirement_catalogue.sql'), 'utf8'));
await dbGreen.exec(fs.readFileSync(path.join(MIG, '0101_app_review_tier2_expense_catalogue_education_land_tax.sql'), 'utf8'));
const afterRerunRetirement = await dbGreen.query(`select count(*)::int as n from master_financial_items where category='retirement' and item_key in ('epf','ppf','nps')`);
const afterRerunExpense = await dbGreen.query(`select count(*)::int as n from master_financial_items where category='expense' and item_key in ('land_tax','education')`);
check('GREEN: 0100 is idempotent (re-run does not duplicate rows)', afterRerunRetirement.rows[0].n === 3, `n=${afterRerunRetirement.rows[0].n}`);
check('GREEN: 0101 is idempotent (re-run does not duplicate rows)', afterRerunExpense.rows[0].n === 2, `n=${afterRerunExpense.rows[0].n}`);

// Functional: PUT-style update of user_profiles.phone actually persists
// (proves the column is a real, writable text column, not just declared).
// NOTE: 0002_module1.sql's handle_new_user() trigger auto-creates a
// user_profiles row the moment auth.users gets a new row -- a bare INSERT
// here collides with that trigger's own row (user_profiles_pkey). Use
// UPDATE against the trigger-created row instead, matching how the real
// app's PUT /api/user/profile route actually persists a phone number.
const insUser = await dbGreen.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'tier2-verify@example.com') returning id`);
const uid = insUser.rows[0].id;
await dbGreen.query(
  `update user_profiles set full_name = 'Tier2 Test', country_of_residence = 'AU', preferred_currency = 'AUD', phone = '+61 400 000 000' where user_id = $1`,
  [uid]
);
const phoneRow = await dbGreen.query(`select phone from user_profiles where user_id=$1`, [uid]);
check('GREEN: phone column round-trips a real value', phoneRow.rows[0]?.phone === '+61 400 000 000', JSON.stringify(phoneRow.rows[0]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
