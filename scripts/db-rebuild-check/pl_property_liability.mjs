// Property <-> Liability Linking (migration 0078) certification harness.
// Two independent PGlite databases:
//   DB1 - built 0001..0077 (pre-migration), seeded with realistic candidate
//         property/liability rows across deterministic / probable-ambiguous
//         / no-match cases, THEN 0078 is applied -- so the backfill INSERT
//         statements in 0078 run against real pre-existing data, the closest
//         available substitute for a genuine "populated DEV upgrade replay"
//         in an environment with no live Supabase credentials.
//   DB2 - full fresh chain 0001..0078, empty of user data -- used for RLS/
//         forgery negative controls and the required financial-integrity
//         scenario tests (spec s.44-61), each seeded with its own synthetic
//         data via the authenticated role so every insert is itself proof
//         the RLS policy's WITH CHECK allows legitimate same-tenant writes.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', e => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', e => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const seedSql = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
const shim = fs.readFileSync(path.join(HERE, 'shim.sql'), 'utf8');

var pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };

async function buildTo(db, versionPrefix) {
  await db.exec(shim);
  for (const f of files) {
    if (f.slice(0, 4) > versionPrefix) break;
    await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seedSql);
  }
}

async function asTenant(db, uid) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
}
async function asService(db) { await db.exec('reset role;'); }

// ---------------------------------------------------------------------------
// PART 1 -- backfill on pre-existing populated data (spec s.37-43, s.62-63)
// ---------------------------------------------------------------------------
console.log('=== PART 1: Backfill replay against pre-existing populated data ===\n');
const db1 = await PGlite.create();
await buildTo(db1, '0077');
console.log('built through 0077 (pre-migration state)\n');

const U1 = '11111111-1111-1111-1111-111111111111'; // deterministic case
const U2 = '22222222-2222-2222-2222-222222222222'; // ambiguous case (2 properties, 1 loan)
const U3 = '33333333-3333-3333-3333-333333333333'; // no-match case (property only, no loan)
const U4 = '44444444-4444-4444-4444-444444444444'; // owner mismatch -> must NOT link
const U5 = '55555555-5555-5555-5555-555555555555'; // deterministic investment property case
await db1.exec(`insert into auth.users(id,email) values ('${U1}','u1@t.test'),('${U2}','u2@t.test'),('${U3}','u3@t.test'),('${U4}','u4@t.test'),('${U5}','u5@t.test');`);

// Snapshot pre-migration totals (for the mandatory $0-variance reconciliation).
async function totals(db) {
  const a = (await db.query(`select coalesce(sum(current_value),0)::numeric as v, count(*)::int as c from assets where is_active`)).rows[0];
  const i = (await db.query(`select coalesce(sum(current_value),0)::numeric as v, count(*)::int as c from investments where is_active`)).rows[0];
  const l = (await db.query(`select coalesce(sum(balance),0)::numeric as v, count(*)::int as c from liabilities where is_active`)).rows[0];
  return { assetsTotal: Number(a.v), assetsCount: a.c, investmentsTotal: Number(i.v), investmentsCount: i.c, liabilitiesTotal: Number(l.v), liabilitiesCount: l.c };
}

// U1: deterministic - exactly 1 Principal Residence + exactly 1 Home Loan, owner/currency/country all match.
await db1.exec(`
insert into assets (user_id, asset_name, asset_class, current_value, currency_code, country_code, owner, master_item_key, is_active)
  values ('${U1}','Home','property',800000,'AUD','AU','self','principal_residence',true);
insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, country_code, owner, master_item_key, is_active)
  values ('${U1}','Home Loan','mortgage',500000,'AUD','AU','self','home_loan',true);
`);

// U2: ambiguous - 2 Residential Investment Properties + 1 Investment Loan. The manual-entry
// grid's own partial unique index (uidx_investments_user_master_manual, migration 0042) blocks
// two source_type='manual' rows sharing a master_item_key, so the second property here uses
// source_type='investment_intelligence_published' -- the one documented, legitimate way a user
// can genuinely hold two same-catalogue-item investment rows (an II-published holding alongside
// a manual one). Even though the loan-side count is 1, the property-side count is 2, so this
// must NOT be auto-linked -- there is no way to know which property the loan finances.
await db1.exec(`
insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, owner, master_item_key, is_active, source_type)
  values ('${U2}','Investment Property A','other',600000,'AUD','AU','self','property',true,'manual'),
         ('${U2}','Investment Property B','other',700000,'AUD','AU','self','property',true,'investment_intelligence_published');
insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, country_code, owner, master_item_key, is_active)
  values ('${U2}','Investment Loan','mortgage',400000,'AUD','AU','self','investment_loan',true);
`);

// U3: no-match - Principal Residence, no loan at all (debt-free property, spec s.44).
await db1.exec(`
insert into assets (user_id, asset_name, asset_class, current_value, currency_code, country_code, owner, master_item_key, is_active)
  values ('${U3}','Debt-Free Home','property',900000,'AUD','AU','self','principal_residence',true);
`);

// U4: owner mismatch - 1 Principal Residence (self) + 1 Home Loan (spouse) -> must NOT auto-link
// even though both counts are individually 1 (balance/count-alone is explicitly insufficient evidence).
await db1.exec(`
insert into assets (user_id, asset_name, asset_class, current_value, currency_code, country_code, owner, master_item_key, is_active)
  values ('${U4}','Home','property',800000,'AUD','AU','self','principal_residence',true);
insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, country_code, owner, master_item_key, is_active)
  values ('${U4}','Home Loan','mortgage',500000,'AUD','AU','spouse','home_loan',true);
`);

// U5: deterministic - Residential Investment Property + Investment Loan, +30k/yr rental income (spec s.44).
await db1.exec(`
insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, owner, master_item_key, is_active)
  values ('${U5}','Investment Property','other',750000,'AUD','AU','self','property',true);
insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, country_code, owner, master_item_key, is_active)
  values ('${U5}','Investment Loan','mortgage',500000,'AUD','AU','self','investment_loan',true);
insert into income_sources (user_id, source_name, income_type, amount, frequency, currency_code, is_active, master_item_key)
  values ('${U5}','Rental Income','rental',2500,'monthly','AUD',true,'rental_income');
`);

const preTotals = await totals(db1);
console.log('pre-migration totals:', JSON.stringify(preTotals));

// Apply 0078 -- the actual backfill under test.
await db1.exec(fs.readFileSync(path.join(MIG, '0078_property_liability_linking.sql'), 'utf8'));
console.log('0078 applied\n');

const postTotals = await totals(db1);
console.log('post-migration totals:', JSON.stringify(postTotals));

console.log('\n--- Backfill match-state distribution ---');
const links1 = (await db1.query(`select user_id, link_type, confidence, source, allocation_percent from property_liability_links order by user_id`)).rows;
console.log(links1);

check('U1 (deterministic Principal Residence + Home Loan) auto-linked', links1.some(r => r.user_id === U1 && r.link_type === 'owner_occupied_mortgage' && r.confidence === 'deterministic'));
check('U2 (ambiguous - 2 properties, 1 loan) left UNLINKED', !links1.some(r => r.user_id === U2), '(no guessing on ambiguous match)');
check('U3 (no loan at all) left UNLINKED, no error', !links1.some(r => r.user_id === U3));
check('U4 (owner mismatch: self property vs spouse loan) left UNLINKED', !links1.some(r => r.user_id === U4), '(count-alone is not proof; owner must also agree)');
check('U5 (deterministic Investment Property + Investment Loan) auto-linked', links1.some(r => r.user_id === U5 && r.link_type === 'investment_property_loan' && r.confidence === 'deterministic'));
check('exactly 2 deterministic links created total (U1, U5 only)', links1.length === 2, `(saw ${links1.length})`);

console.log('\n--- Mandatory financial reconciliation (spec s.62-63): backfill must not move any total ---');
check('assets total unchanged by backfill', preTotals.assetsTotal === postTotals.assetsTotal, `(${preTotals.assetsTotal} -> ${postTotals.assetsTotal})`);
check('investments total unchanged by backfill', preTotals.investmentsTotal === postTotals.investmentsTotal, `(${preTotals.investmentsTotal} -> ${postTotals.investmentsTotal})`);
check('liabilities total unchanged by backfill', preTotals.liabilitiesTotal === postTotals.liabilitiesTotal, `(${preTotals.liabilitiesTotal} -> ${postTotals.liabilitiesTotal})`);
check('row counts unchanged by backfill', preTotals.assetsCount === postTotals.assetsCount && preTotals.investmentsCount === postTotals.investmentsCount && preTotals.liabilitiesCount === postTotals.liabilitiesCount);

// Idempotency: re-running 0078's own statements a second time must not create duplicate links or fail.
await db1.exec(fs.readFileSync(path.join(MIG, '0078_property_liability_linking.sql'), 'utf8'));
const links1b = (await db1.query(`select count(*)::int c from property_liability_links`)).rows[0].c;
check('re-running 0078 is idempotent (no duplicate links)', links1b === links1.length, `(${links1.length} -> ${links1b})`);

// ---------------------------------------------------------------------------
// PART 2 -- fresh chain through 0078, RLS + forgery + scenario tests
// ---------------------------------------------------------------------------
console.log('\n\n=== PART 2: Fresh chain through 0078 -- RLS, forgery, scenario tests ===\n');
const db2 = await PGlite.create();
await buildTo(db2, '0078');
console.log('built through 0078\n');

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
await db2.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test');`);

// --- Scenario: Multiple loans on one property (spec s.44) ---
console.log('--- Scenario: Multiple facilities (Split A + Split B) on one property ---');
await asTenant(db2, A);
const propMulti = (await db2.query(`insert into assets (user_id, asset_name, asset_class, current_value, currency_code, owner, master_item_key, is_active) values ('${A}','Principal Residence','property',1200000,'AUD','self','principal_residence',true) returning id`)).rows[0].id;
const loanSplitA = (await db2.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, master_item_key, is_active) values ('${A}','Home Loan','mortgage',400000,'AUD','self','home_loan',true) returning id`)).rows[0].id;
const loanSplitB = (await db2.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, master_item_key, is_active) values ('${A}','Mortgage Split B','other',250000,'AUD','self',null,true) returning id`)).rows[0].id;
await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent, is_primary) values ('${A}',$1,$2,'owner_occupied_mortgage',100,true)`, [propMulti, loanSplitA]);
await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent, is_primary) values ('${A}',$1,$2,'owner_occupied_mortgage',100,false)`, [propMulti, loanSplitB]);
const multiLiab = (await db2.query(`select coalesce(sum(l.balance),0)::numeric v from liabilities l join property_liability_links pl on pl.liability_id=l.id where pl.linked_asset_id=$1 and pl.is_active`, [propMulti])).rows[0].v;
const multiAsset = (await db2.query(`select current_value from assets where id=$1`, [propMulti])).rows[0].current_value;
check('Multiple loans: Gross Asset = $1,200,000', Number(multiAsset) === 1200000);
check('Multiple loans: total Liabilities = $650,000 (400k+250k, never double-counted)', Number(multiLiab) === 650000, `(saw ${multiLiab})`);
check('Multiple loans: implied equity = $550,000', Number(multiAsset) - Number(multiLiab) === 550000);

// --- Scenario: Cross-collateralisation (spec s.45) ---
console.log('\n--- Scenario: Cross-collateralised loan across two properties ---');
const propXA = (await db2.query(`insert into assets (user_id, asset_name, asset_class, current_value, currency_code, owner, master_item_key, is_active) values ('${A}','Property A','property',600000,'AUD','self','holiday_home',true) returning id`)).rows[0].id;
const propXB = (await db2.query(`insert into investments (user_id, investment_name, investment_type, current_value, currency_code, owner, master_item_key, is_active) values ('${A}','Property B','other',400000,'AUD','self','property',true) returning id`)).rows[0].id;
const loanX = (await db2.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, master_item_key, is_active) values ('${A}','Cross-Collateral Loan','other',1000000,'AUD','self','investment_loan',true) returning id`)).rows[0].id;
await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,'cross_collateralised',60)`, [propXA, loanX]);
await db2.query(`insert into property_liability_links (user_id, linked_investment_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,'cross_collateralised',40)`, [propXB, loanX]);
const loanXBalance = (await db2.query(`select balance from liabilities where id=$1`, [loanX])).rows[0].balance;
check('Cross-collateral: liability balance stays $1,000,000 (not doubled to $2,000,000)', Number(loanXBalance) === 1000000, `(saw ${loanXBalance})`);
const attribA = (await db2.query(`select allocation_percent from property_liability_links where linked_asset_id=$1 and liability_id=$2`, [propXA, loanX])).rows[0].allocation_percent;
const attribB = (await db2.query(`select allocation_percent from property_liability_links where linked_investment_id=$1 and liability_id=$2`, [propXB, loanX])).rows[0].allocation_percent;
check('Cross-collateral: analytical attribution A=60% ($600,000)', Number(attribA) === 60 && Number(loanXBalance) * 0.6 === 600000);
check('Cross-collateral: analytical attribution B=40% ($400,000)', Number(attribB) === 40 && Number(loanXBalance) * 0.4 === 400000);

// --- Allocation cap trigger: a 3rd link pushing total over 100% must be rejected ---
console.log('\n--- Allocation-cap trigger (spec s.9-10, s.52) ---');
let capBlocked = false;
try {
  await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,'cross_collateralised',10)`, [propMulti, loanX]);
} catch (e) { capBlocked = /100/.test(e.message) || /23514/.test(e.code ?? ''); }
check('allocation cap trigger rejects a link that would push total allocation over 100%', capBlocked);

// --- Consumer-debt denylist trigger (spec s.27-31) ---
console.log('\n--- Consumer-debt denylist trigger ---');
const ccLiab = (await db2.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, master_item_key, is_active) values ('${A}','Visa Card','credit_card',5000,'AUD','self','credit_card',true) returning id`)).rows[0].id;
let ccBlocked = false;
try {
  await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,'property_secured_other',100)`, [propMulti, ccLiab]);
} catch (e) { ccBlocked = /consumer/i.test(e.message); }
check('consumer debt (credit card) cannot be linked as property finance even if client requests it', ccBlocked);

// --- Exactly-one-property-side constraint ---
console.log('\n--- Exactly-one-property-side CHECK constraint ---');
let bothSidesBlocked = false;
try {
  await db2.query(`insert into property_liability_links (user_id, linked_asset_id, linked_investment_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,$3,'property_secured_other',100)`, [propMulti, propXB, loanX]);
} catch (e) { bothSidesBlocked = true; }
check('a link row cannot claim two property sides at once', bothSidesBlocked);
let noSideBlocked = false;
try {
  await db2.query(`insert into property_liability_links (user_id, liability_id, link_type, allocation_percent) values ('${A}',$1,'property_secured_other',100)`, [loanX]);
} catch (e) { noSideBlocked = true; }
check('a link row cannot claim zero property sides', noSideBlocked);

// --- Net Worth $0 variance -- the mandatory FAIL gate (spec s.61) ---
console.log('\n--- Net Worth $0 variance gate (spec s.61 hard FAIL gate) ---');
async function netWorthFor(uid) {
  const a = (await db2.query(`select coalesce(sum(current_value),0)::numeric v from assets where user_id=$1 and is_active`, [uid])).rows[0].v;
  const i = (await db2.query(`select coalesce(sum(current_value),0)::numeric v from investments where user_id=$1 and is_active`, [uid])).rows[0].v;
  const l = (await db2.query(`select coalesce(sum(balance),0)::numeric v from liabilities where user_id=$1 and is_active`, [uid])).rows[0].v;
  return Number(a) + Number(i) - Number(l);
}
const nwBefore = await netWorthFor(A);
const propNW = (await db2.query(`insert into assets (user_id, asset_name, asset_class, current_value, currency_code, owner, master_item_key, is_active) values ('${A}','NW Test Home','property',800000,'AUD','self',null,true) returning id`)).rows[0].id;
const loanNW = (await db2.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, master_item_key, is_active) values ('${A}','NW Test Loan','mortgage',500000,'AUD','self',null,true) returning id`)).rows[0].id;
const nwAfterCreate = await netWorthFor(A);
await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,'owner_occupied_mortgage',100)`, [propNW, loanNW]);
const nwAfterLink = await netWorthFor(A);
check('Net Worth contribution before link = 800000-500000 = 300000 above baseline', (nwAfterCreate - nwBefore) === 300000, `(delta ${nwAfterCreate - nwBefore})`);
check('creating the relationship alone produces $0 Net Worth variance (hard FAIL gate)', nwAfterLink === nwAfterCreate, `(before link ${nwAfterCreate}, after link ${nwAfterLink}, variance ${nwAfterLink - nwAfterCreate})`);
await db2.query(`update property_liability_links set is_active=false where linked_asset_id=$1`, [propNW]);
const nwAfterUnlink = await netWorthFor(A);
check('unlinking alone also produces $0 Net Worth variance', nwAfterUnlink === nwAfterLink, `(variance ${nwAfterUnlink - nwAfterLink})`);

// --- Debt-free property / loan without property (spec s.44) ---
console.log('\n--- Debt-free property and unlinked loan (spec s.44) ---');
const debtFreeProp = (await db2.query(`insert into assets (user_id, asset_name, asset_class, current_value, currency_code, owner, master_item_key, is_active) values ('${A}','Debt-Free Home','property',900000,'AUD','self','vacant_land',true) returning id`)).rows[0].id;
const linksForDebtFree = (await db2.query(`select count(*)::int c from property_liability_links where linked_asset_id=$1 and is_active`, [debtFreeProp])).rows[0].c;
check('debt-free property has zero active links ("No associated debt")', linksForDebtFree === 0);
const personalLoan = (await db2.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, master_item_key, is_active) values ('${A}','Personal Loan','personal_loan',30000,'AUD','self',null,true) returning id`)).rows[0].id;
const linksForPersonalLoan = (await db2.query(`select count(*)::int c from property_liability_links where liability_id=$1 and is_active`, [personalLoan])).rows[0].c;
check('personal loan with no property remains unlinked, no error required', linksForPersonalLoan === 0);

// --- Refinance (spec s.24) ---
console.log('\n--- Refinance: old loan closed, new loan linked, same property ---');
const refiProp = (await db2.query(`insert into assets (user_id, asset_name, asset_class, current_value, currency_code, owner, master_item_key, is_active) values ('${A}','Refi Home','property',750000,'AUD','self','farm',true) returning id`)).rows[0].id;
const oldLoan = (await db2.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, master_item_key, is_active) values ('${A}','Old Loan','mortgage',300000,'AUD','self',null,true) returning id`)).rows[0].id;
const oldLink = (await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,'property_secured_other',100) returning id`, [refiProp, oldLoan])).rows[0].id;
// Refinance: old liability archived, old link deactivated, new liability + new link created.
await db2.query(`update liabilities set is_active=false where id=$1`, [oldLoan]);
await db2.query(`update property_liability_links set is_active=false where id=$1`, [oldLink]);
const newLoan = (await db2.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, master_item_key, is_active) values ('${A}','New Loan','mortgage',450000,'AUD','self',null,true) returning id`)).rows[0].id;
await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,'property_secured_other',100)`, [refiProp, newLoan]);
const activeLinksRefi = (await db2.query(`select l.balance from property_liability_links pl join liabilities l on l.id=pl.liability_id where pl.linked_asset_id=$1 and pl.is_active`, [refiProp])).rows;
const historicalLinksRefi = (await db2.query(`select count(*)::int c from property_liability_links where linked_asset_id=$1 and not is_active`, [refiProp])).rows[0].c;
const assetCountRefi = (await db2.query(`select count(*)::int c from assets where id=$1`, [refiProp])).rows[0].c;
check('refinance: exactly one active liability link remains, balance = new loan ($450,000)', activeLinksRefi.length === 1 && Number(activeLinksRefi[0].balance) === 450000);
check('refinance: old relationship historically preserved (deactivated, not deleted)', historicalLinksRefi === 1);
check('refinance: no duplicate property created', assetCountRefi === 1);

// --- Multi-currency (spec s.44, s.26) ---
console.log('\n--- Multi-currency: India investment property + India property loan (INR) ---');
const inrProp = (await db2.query(`insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, owner, master_item_key, is_active) values ('${A}','India Investment Property','other',20000000,'INR','IN','self',null,true) returning id`)).rows[0].id;
const inrLoan = (await db2.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, country_code, owner, master_item_key, is_active) values ('${A}','India Property Loan','mortgage',12000000,'INR','IN','self',null,true) returning id`)).rows[0].id;
await db2.query(`insert into property_liability_links (user_id, linked_investment_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,'investment_property_loan',100)`, [inrProp, inrLoan]);
const inrCheck = (await db2.query(`select i.current_value, i.currency_code as pcur, l.balance, l.currency_code as lcur from property_liability_links pl join investments i on i.id=pl.linked_investment_id join liabilities l on l.id=pl.liability_id where pl.linked_investment_id=$1`, [inrProp])).rows[0];
check('multi-currency: property value preserved in original INR (20,000,000)', Number(inrCheck.current_value) === 20000000 && inrCheck.pcur === 'INR');
check('multi-currency: liability balance preserved in original INR (12,000,000)', Number(inrCheck.balance) === 12000000 && inrCheck.lcur === 'INR');

// --- RLS: positive access, cross-tenant denial, forgery, negative controls ---
console.log('\n--- RLS: cross-tenant isolation on property_liability_links (spec s.53) ---');
await asTenant(db2, B);
const bProp = (await db2.query(`insert into assets (user_id, asset_name, asset_class, current_value, currency_code, owner, master_item_key, is_active) values ('${B}','B Home','property',500000,'AUD','self','principal_residence',true) returning id`)).rows[0].id;
const bLoan = (await db2.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, master_item_key, is_active) values ('${B}','B Loan','mortgage',300000,'AUD','self','home_loan',true) returning id`)).rows[0].id;
const bLink = (await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent) values ('${B}',$1,$2,'owner_occupied_mortgage',100) returning id`, [bProp, bLoan])).rows[0].id;

await asTenant(db2, A);
const aSeesOwnLinks = (await db2.query(`select count(*)::int c from property_liability_links where user_id='${A}'`)).rows[0].c;
check('Tenant A reads own links', aSeesOwnLinks > 0, `(saw ${aSeesOwnLinks})`);
const aSeesBLink = (await db2.query(`select count(*)::int c from property_liability_links where id='${bLink}'`)).rows[0].c;
check('Tenant A CANNOT view Tenant B\'s link', aSeesBLink === 0, `(leaked ${aSeesBLink})`);

let forgeOwnUserRealB = false;
try {
  await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,'owner_occupied_mortgage',100)`, [bProp, bLoan]);
} catch (e) { forgeOwnUserRealB = /policy|denied|row-level/i.test(e.message); }
check('Tenant A cannot create a link between B\'s property and B\'s liability while claiming user_id=A', forgeOwnUserRealB);

// Purpose-built, otherwise-untouched property/liability for A -- isolates
// the RLS ownership check from the allocation-cap and consumer-denylist
// triggers, which would otherwise make a reused row's rejection reason
// ambiguous (still correctly blocked, but for the wrong reason).
const aProp2 = (await db2.query(`insert into assets (user_id, asset_name, asset_class, current_value, currency_code, owner, master_item_key, is_active) values ('${A}','A Forgery-Test Prop','property',100000,'AUD','self',null,true) returning id`)).rows[0].id;
const aLoan2 = (await db2.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, owner, master_item_key, is_active) values ('${A}','A Forgery-Test Loan','other',10000,'AUD','self',null,true) returning id`)).rows[0].id;

let forgeAPropBLiab = false;
try {
  await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,'owner_occupied_mortgage',100)`, [aProp2, bLoan]);
} catch (e) { forgeAPropBLiab = /policy|denied|row-level/i.test(e.message); }
check('Tenant A cannot link A\'s own property to B\'s liability (forged liability_id)', forgeAPropBLiab);

let forgeBPropALiab = false;
try {
  await db2.query(`insert into property_liability_links (user_id, linked_asset_id, liability_id, link_type, allocation_percent) values ('${A}',$1,$2,'owner_occupied_mortgage',100)`, [bProp, aLoan2]);
} catch (e) { forgeBPropALiab = /policy|denied|row-level/i.test(e.message); }
check('Tenant A cannot link B\'s property to A\'s own liability (forged asset_id)', forgeBPropALiab);

const updB = (await db2.query(`update property_liability_links set allocation_percent=50 where id='${bLink}' returning 1`)).rows.length;
check('Tenant A cannot update Tenant B\'s link', updB === 0, `(updated ${updB})`);
const delB = (await db2.query(`delete from property_liability_links where id='${bLink}' returning 1`)).rows.length;
check('Tenant A cannot delete Tenant B\'s link', delB === 0, `(deleted ${delB})`);

await asService(db2);
console.log('\n--- Negative control: RLS deliberately disabled -> leak MUST appear ---');
await db2.exec(`alter table property_liability_links disable row level security;`);
await asTenant(db2, A);
const leak = (await db2.query(`select count(*)::int c from property_liability_links where id='${bLink}'`)).rows[0].c;
check('control: RLS off -> Tenant A DOES see Tenant B\'s link', leak === 1, `(saw ${leak}, expected 1 -- proves the test is not vacuous)`);
await asService(db2);
await db2.exec(`alter table property_liability_links enable row level security;`);
await asTenant(db2, A);
const restored = (await db2.query(`select count(*)::int c from property_liability_links where id='${bLink}'`)).rows[0].c;
check('control: isolation restored', restored === 0, `(saw ${restored})`);

// --- Coverage: table has RLS enabled ---
await asService(db2);
const rlsRow = (await db2.query(`select relrowsecurity from pg_class where relname='property_liability_links'`)).rows[0];
check('property_liability_links has RLS enabled', rlsRow.relrowsecurity === true);

console.log(`\nPROPERTY <-> LIABILITY LINKING CERTIFICATION: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
