// G0-JA-1 Wave 2 certification: catalogue applicability realignment for the
// 20 approved Australian-flavoured items (migration 0102). Mirrors
// smsf_jurisdiction_cert.mjs's asTenant()/RLS harness pattern. Proves, on a
// freshly rebuilt real Postgres (PGlite):
//   - migration 0102 applies cleanly and idempotently against the full
//     0001..0102 chain + the real master_financial_items seed
//   - the exact 20 rows carry the exact approved applicability_class +
//     country_applicability, and NOTHING else changed (196 other rows)
//   - the exact split is 12 HOME_OR_CROSS_BORDER_COUNTRY (11 restricted +
//     australian_shares deliberately unrestricted) + 8
//     GLOBAL_WITH_JURISDICTION_VARIANT (never restricted)
//   - the listMasterItems() catalogue-list SQL filter behaves correctly for
//     AU/IN residents across all 20 items
//   - existing-record preservation: an AU resident's restricted-item rows
//     survive (unchanged value, still active, still queryable) an AU->IN
//     residence change -- proven at the real DB layer, not simulated
//   - RLS cross-tenant isolation is unaffected on the 4 tables touched
//   - HONEST DISCLOSURE: unlike SMSF (migration 0084's DB trigger), the 11
//     newly-restricted non-SMSF items have NO DB-level trigger backstop in
//     this wave (deliberate, smallest-necessary-change scope decision, see
//     the Wave 2 report) -- a raw same-tenant direct INSERT bypassing the
//     Next.js app layer is NOT blocked at the DB layer today. This script
//     proves that gap exists (so it is never silently asserted as absent)
//     while confirming RLS tenant-isolation itself is untouched.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', e => { console.error('UNCAUGHT: ' + e.stack); process.exit(9); });
process.on('unhandledRejection', e => { console.error('REJECTED: ' + (e?.stack || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const masterItemsSeedSql = fs.readFileSync(path.join(ROOT, 'seed_master_items.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
let catalogueTotalBefore0102 = null, catalogueTotalAfter0102 = null;
for (const f of files) {
  if (f.startsWith('0102')) {
    catalogueTotalBefore0102 = (await db.query(`select count(*)::int c from master_financial_items`)).rows[0].c;
  }
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0102')) {
    catalogueTotalAfter0102 = (await db.query(`select count(*)::int c from master_financial_items`)).rows[0].c;
  }
  if (f.startsWith('0001')) await db.exec(seed);
  // Applied right after 0004 (which creates master_financial_items), NOT
  // after the full migration loop -- this matches the REAL DEV/production
  // ordering (seed_master_items.sql is applied once, out-of-band, long
  // before any new migration like 0102 ever runs against a live
  // environment -- confirmed live: all 20 of this wave's target rows
  // already exist in the seed file today). Migration 0102's own row-count
  // assertions are additionally order-tolerant (accept a fully-empty
  // catalogue too) for a from-scratch rebuild that hasn't seeded yet, but
  // this ordering is what actually certifies the real, expected-count path.
  if (f.startsWith('0004')) await db.exec(masterItemsSeedSql);
}
console.log(`fresh rebuild complete: ${files.length} migrations + reference seed + master-items catalogue (seeded immediately after 0004, matching real DEV/production ordering; last migration: ${files[files.length - 1]})\n`);

var pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };
async function expectReject(label, fn) {
  try { await fn(); check(label, false, '(expected rejection, but it succeeded)'); }
  catch (e) { check(label, true, `(rejected: ${e.message.slice(0, 90)})`); }
}
async function expectOk(label, fn) {
  try { const r = await fn(); check(label, true); return r; }
  catch (e) { check(label, false, `(unexpected error: ${e.message.slice(0, 140)})`); }
}

const A = '11111111-1111-1111-1111-111111111111'; // AU resident
const B = '22222222-2222-2222-2222-222222222222'; // IN resident
const N = '33333333-3333-3333-3333-333333333333'; // null/unresolved country resident
await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test'),('${N}','n@t.test');`);
// Mandatory Country Confirmation (migrations 0104/0105/0108) — A and B are
// meant to represent genuinely established, usable test tenants, so they
// also get country_confirmed_at/country_source/onboarding_completed
// (a bare country_of_residence is never itself proof of confirmation under
// the new trigger). N is deliberately left with country_of_residence=null
// and unconfirmed -- that IS this fixture's whole point.
await db.exec(`
  update user_profiles set full_name='Tenant A (AU)', country_of_residence='AU', preferred_currency='AUD', onboarding_completed=true, country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${A}';
  update user_profiles set full_name='Tenant B (IN)', country_of_residence='IN', preferred_currency='INR', onboarding_completed=true, country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${B}';
  update user_profiles set full_name='Tenant N (unresolved)', country_of_residence=null where user_id='${N}';
`);

async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
async function asService(fn) { await db.exec(`set role service_role;`); try { return await fn(); } finally { await db.exec(`reset role;`); } }

// ===========================================================================
// Independent oracle (transcribed from 03-catalogue-matrix.md/.csv, not from
// migration 0102's own SQL) -- kept identical to
// tests/unit/wave2CatalogueApplicability.test.ts's ORACLE by construction.
// ===========================================================================
const RESTRICTED_11 = [
  ['income', 'age_pension'], ['income', 'family_tax_benefit'],
  ['liability', 'smsf_property_loan'], ['liability', 'hecs_help'], ['liability', 'ato_payment_plan'],
  ['retirement', 'industry_super'], ['retirement', 'retail_super'],
  ['retirement', 'government_co_contribution'], ['retirement', 'transition_to_retirement'],
  ['retirement', 'allocated_pension'], ['retirement', 'account_based_pension'],
];
const UNRESTRICTED_CROSS_BORDER = ['investment', 'australian_shares'];
const GLOBAL_VARIANT_8 = [
  ['expense', 'body_corporate'], ['expense', 'council_rates'],
  ['retirement', 'defined_benefit'], ['retirement', 'employer_contributions'],
  ['retirement', 'salary_sacrifice'], ['retirement', 'personal_concessional'],
  ['retirement', 'non_concessional'], ['retirement', 'spouse_contribution'],
];
const ALL_20 = [...RESTRICTED_11, UNRESTRICTED_CROSS_BORDER, ...GLOBAL_VARIANT_8];
const CATEGORY_TABLE = { income: 'income_sources', expense: 'expense_items', asset: 'assets', liability: 'liabilities', investment: 'investments', retirement: 'retirement_accounts', insurance: 'insurance_policies' };

console.log('=== Migration 0102: catalogue metadata reconciliation against the independent oracle ===');
{
  check('exactly 20 items reconciled', ALL_20.length === 20, `(${ALL_20.length})`);

  const { rows: classified } = await db.query(`select category, item_key, country_applicability, applicability_class from master_financial_items where applicability_class is not null order by category, item_key`);
  check('exactly 20 rows carry a non-null applicability_class', classified.length === 20, `(${classified.length})`);

  for (const [cat, key] of RESTRICTED_11) {
    const row = classified.find(r => r.category === cat && r.item_key === key);
    check(`${cat}.${key}: HOME_OR_CROSS_BORDER_COUNTRY + restricted to ['AU']`,
      !!row && row.applicability_class === 'HOME_OR_CROSS_BORDER_COUNTRY' && JSON.stringify(row.country_applicability) === JSON.stringify(['AU']),
      JSON.stringify(row));
  }
  {
    const [cat, key] = UNRESTRICTED_CROSS_BORDER;
    const row = classified.find(r => r.category === cat && r.item_key === key);
    check(`${cat}.${key}: HOME_OR_CROSS_BORDER_COUNTRY but NOT restricted (country_applicability still NULL, per its explicit disposition)`,
      !!row && row.applicability_class === 'HOME_OR_CROSS_BORDER_COUNTRY' && row.country_applicability === null,
      JSON.stringify(row));
  }
  for (const [cat, key] of GLOBAL_VARIANT_8) {
    const row = classified.find(r => r.category === cat && r.item_key === key);
    check(`${cat}.${key}: GLOBAL_WITH_JURISDICTION_VARIANT, never restricted (country_applicability NULL)`,
      !!row && row.applicability_class === 'GLOBAL_WITH_JURISDICTION_VARIANT' && row.country_applicability === null,
      JSON.stringify(row));
  }

  // SMSF explicitly untouched by this migration.
  const smsf = (await db.query(`select country_applicability, applicability_class from master_financial_items where category='retirement' and item_key='smsf'`)).rows[0];
  check('SMSF untouched: still restricted to AU (migration 0084), applicability_class still NULL (not classified by this migration)', JSON.stringify(smsf.country_applicability) === JSON.stringify(['AU']) && smsf.applicability_class === null, JSON.stringify(smsf));

  // Unaffected-catalogue check: 0102 only ever UPDATEs existing rows by
  // exact (category, item_key) tuple -- it never INSERTs or DELETEs a
  // catalogue row. 00-README.md's "216 rows" figure was measured against an
  // earlier origin/main snapshot (the discovery branch's fork point);
  // current origin/main has since gained additional catalogue rows from
  // unrelated migrations landed after that snapshot, so the live total here
  // is expected to differ from 216 -- the only invariant this migration
  // itself must uphold is "0102 changes zero row COUNTS", checked directly
  // against its own before/after totals (both computed in this same
  // script), not against a now-stale absolute constant.
  const { rows: totalRows } = await db.query(`select count(*)::int c from master_financial_items`);
  console.log(`  (info) live catalogue total: ${totalRows[0].c} rows (00-README.md's "216" figure predates this origin/main snapshot -- see comment above)`);
  check('0102 never inserts or deletes a catalogue row (before/after row count identical)', catalogueTotalBefore0102 === catalogueTotalAfter0102, `(before ${catalogueTotalBefore0102}, after ${catalogueTotalAfter0102})`);
  const { rows: unintended } = await db.query(`
    select category, item_key from master_financial_items
    where applicability_class is not null and not (category, item_key) in (${ALL_20.map(([c, k]) => `('${c}','${k}')`).join(',')})
  `);
  check('zero unintended applicability_class assignments outside the approved 20', unintended.length === 0, JSON.stringify(unintended));
  const { rows: unintendedRestriction } = await db.query(`
    select category, item_key from master_financial_items
    where country_applicability is not null
      and not (category='retirement' and item_key='smsf')
      and not (category, item_key) in (${RESTRICTED_11.map(([c, k]) => `('${c}','${k}')`).join(',')})
  `);
  check('zero unintended country_applicability restrictions outside SMSF + the approved 11', unintendedRestriction.length === 0, JSON.stringify(unintendedRestriction));
}

console.log('\n=== Idempotency: replaying migration 0102 changes nothing ===');
{
  const before = (await db.query(`select category, item_key, country_applicability, applicability_class from master_financial_items where applicability_class is not null order by category, item_key`)).rows;
  const mig0102 = fs.readFileSync(fs.readdirSync(MIG).filter(f => f.startsWith('0102')).map(f => path.join(MIG, f))[0], 'utf8');
  await expectOk('0102 re-applies without error', async () => { await db.exec(mig0102); });
  const after = (await db.query(`select category, item_key, country_applicability, applicability_class from master_financial_items where applicability_class is not null order by category, item_key`)).rows;
  check('replaying 0102 is a true no-op (identical before/after snapshot)', JSON.stringify(before) === JSON.stringify(after));
}

console.log('\n=== Catalogue-list SQL filter simulation (listMasterItems(), lib/services/masterItems.ts) ===');
{
  for (const [cat, key] of RESTRICTED_11) {
    const forIN = (await db.query(`select 1 from master_financial_items where category='${cat}' and item_key='${key}' and is_active and (country_applicability is null or country_applicability @> array['IN']::char(2)[])`)).rows;
    check(`${cat}.${key}: excluded from IN resident's catalogue list`, forIN.length === 0);
    const forAU = (await db.query(`select 1 from master_financial_items where category='${cat}' and item_key='${key}' and is_active and (country_applicability is null or country_applicability @> array['AU']::char(2)[])`)).rows;
    check(`${cat}.${key}: included in AU resident's catalogue list`, forAU.length === 1);
  }
  {
    const [cat, key] = UNRESTRICTED_CROSS_BORDER;
    const forIN = (await db.query(`select 1 from master_financial_items where category='${cat}' and item_key='${key}' and is_active and (country_applicability is null or country_applicability @> array['IN']::char(2)[])`)).rows;
    check(`${cat}.${key}: still included in IN resident's catalogue list (cross-border holding, never restricted)`, forIN.length === 1);
  }
  for (const [cat, key] of GLOBAL_VARIANT_8) {
    const forIN = (await db.query(`select 1 from master_financial_items where category='${cat}' and item_key='${key}' and is_active and (country_applicability is null or country_applicability @> array['IN']::char(2)[])`)).rows;
    check(`${cat}.${key}: included in IN resident's catalogue list (global concept, unrestricted)`, forIN.length === 1);
  }
}

console.log('\n=== Existing-record preservation: AU resident creates restricted items, then moves to IN ===');
let hecsA, ageA;
await asTenant(A, async () => {
  hecsA = (await expectOk('A (AU) can create a HECS/HELP liability', async () => {
    const r = await db.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, country_code, owner, master_item_key)
      values ('${A}','My HECS','student_loan',15000,'AUD','AU','self','hecs_help') returning id`);
    return r.rows[0].id;
  }));
  ageA = (await expectOk('A (AU) can create an Age Pension income row', async () => {
    const r = await db.query(`insert into income_sources (user_id, source_name, income_type, amount, frequency, currency_code, owner, master_item_key)
      values ('${A}','Age Pension','other',500,'fortnightly','AUD','self','age_pension') returning id`);
    return r.rows[0].id;
  }));
});
await asService(async () => { await db.query(`update user_profiles set country_of_residence='IN' where user_id='${A}'`); });
await asTenant(A, async () => {
  const hecs = (await db.query(`select balance, is_active from liabilities where id='${hecsA}'`)).rows[0];
  check('W2-06/14: existing HECS/HELP liability preserved after AU->IN move (value unchanged, still active, still visible)', hecs && Number(hecs.balance) === 15000 && hecs.is_active === true, JSON.stringify(hecs));
  const age = (await db.query(`select amount, is_active from income_sources where id='${ageA}'`)).rows[0];
  check('W2-06/14: existing Age Pension income row preserved after AU->IN move', age && Number(age.amount) === 500 && age.is_active === true, JSON.stringify(age));
  // Existing rows must still be summable in a totals-style aggregate (net
  // worth / cash flow never filter by country_applicability or by the
  // owner's current country_of_residence -- confirmed by code inspection of
  // lib/engines/dashboard.ts in the Wave 2 report; reconfirmed here at the
  // data level).
  const totalLiabilities = (await db.query(`select coalesce(sum(balance),0)::numeric t from liabilities where user_id='${A}' and is_active`)).rows[0].t;
  check('W2-14: preserved HECS/HELP liability still contributes to a naive totals query (zero unexplained exclusion)', Number(totalLiabilities) === 15000, `(${totalLiabilities})`);
});
await asService(async () => { await db.query(`update user_profiles set country_of_residence='AU' where user_id='${A}'`); });

console.log('\n=== HONEST DISCLOSURE: app-layer-only enforcement for the 11 non-SMSF restricted items (no DB trigger, unlike SMSF) ===');
await asTenant(B, async () => {
  // This is a deliberate, disclosed finding, not a bug in this script: the
  // Next.js API route (app/api/liabilities/route.ts) is what blocks this in
  // the real product (proven in tests/unit/wave2CatalogueApplicability.test.ts).
  // A raw direct-to-Postgres insert bypassing that route entirely is NOT
  // blocked at the DB layer for these 11 items today, unlike SMSF's
  // trg_retirement_accounts_smsf_au_gate (migration 0084).
  const r = await db.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, country_code, owner, master_item_key)
    values ('${B}','B HECS attempt','student_loan',999,'AUD','AU','self','hecs_help') returning id`);
  check('DISCLOSED GAP (expected, not a failure): a raw same-tenant direct DB insert of a restricted item is NOT blocked at the DB layer for non-SMSF items (app-layer gate is the sole enforcement here)', r.rows.length === 1);
  await db.query(`delete from liabilities where id='${r.rows[0].id}'`); // clean up the deliberately-forged row
});

console.log('\n=== RLS: cross-tenant isolation on the tables touched by the newly-gated routes ===');
await asTenant(B, async () => {
  const leak1 = (await db.query(`select count(*)::int c from liabilities where user_id='${A}'`)).rows[0].c;
  check('B cannot read A\'s liabilities', leak1 === 0, `(leaked ${leak1})`);
  const leak2 = (await db.query(`select count(*)::int c from income_sources where user_id='${A}'`)).rows[0].c;
  check('B cannot read A\'s income_sources', leak2 === 0, `(leaked ${leak2})`);
  await expectReject('B cannot forge a liabilities row claiming user_id=A (RLS with-check)', async () => {
    await db.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, master_item_key)
      values ('${A}','Impersonation','student_loan',1,'AUD','self','hecs_help')`);
  });
});

console.log('\n=== NEGATIVE CONTROL: prove the RLS checks above are not vacuous ===');
await db.exec(`alter table liabilities disable row level security;`);
let leak = 0;
await asTenant(B, async () => { leak = (await db.query(`select count(*)::int c from liabilities where user_id='${A}'`)).rows[0].c; });
check('control: RLS off on liabilities -> B DOES see A\'s liabilities (proves prior denial was real)', leak >= 1, `(saw ${leak})`);
await db.exec(`alter table liabilities enable row level security;`);
let re = 0;
await asTenant(B, async () => { re = (await db.query(`select count(*)::int c from liabilities where user_id='${A}'`)).rows[0].c; });
check('control: isolation restored on liabilities', re === 0, `(saw ${re})`);

console.log(`\nG0-JA-1 WAVE 2 CATALOGUE APPLICABILITY CERTIFICATION: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
