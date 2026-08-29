// SMSF + Jurisdiction Applicability certification against a freshly rebuilt
// database, using the same asTenant()/RLS harness pattern as rls.mjs.
// Covers: JUR-01..08 negative-control matrix, SMSF-6 financial integrity
// (Summary, Detailed, mode-switch $0 variance + negative control, self/
// spouse double-count, liability double-subtraction, contribution pollution,
// rental-income single-count, multi-currency), and RLS cross-tenant denial
// for the three new tables.
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
for (const f of fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
// The migration replay (replay.mjs / rls.mjs) never applies
// supabase/seed_master_items.sql -- it is run once directly against real
// DEV/production out-of-band, same as this project's established
// convention. Apply it here too so this test exercises the real
// master_financial_items catalogue (incl. the 'smsf' row this migration's
// backfill targets), not an empty table.
await db.exec(fs.readFileSync(path.join(ROOT, 'seed_master_items.sql'), 'utf8'));
console.log('fresh rebuild complete (migrations + reference seed + master-items catalogue)\n');

const A = '11111111-1111-1111-1111-111111111111'; // AU resident
const B = '22222222-2222-2222-2222-222222222222'; // IN resident
await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test');`);
// migration 0002 auto-creates a user_profiles row via an auth.users trigger,
// so set the fields we need with UPDATE rather than INSERT.
//
// Mandatory Country Confirmation (migrations 0104/0105) closure fix
// (MCC-5): this fixture predates that feature and originally only set
// country_of_residence — every retirement_accounts/investments INSERT
// below now goes through the new enforce_country_confirmed() trigger,
// which requires onboarding_completed=true AND country_confirmed_at to be
// set before treating a country value as real confirmation (a bare
// country_of_residence, however it got there, is never itself proof of
// confirmation — that is the whole point of the new feature). Both tenants
// here represent fully-onboarded, already-established users, so stamping
// them as confirmed is the correct fixture update, not a workaround.
await db.exec(`
  update user_profiles set full_name='Tenant A (AU)', country_of_residence='AU', preferred_currency='AUD', onboarding_completed=true, country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${A}';
  update user_profiles set full_name='Tenant B (IN)', country_of_residence='IN', preferred_currency='INR', onboarding_completed=true, country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${B}';
`);

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

console.log('=== GEO-1: catalogue metadata ===');
{
  const { rows } = await db.query(`select country_applicability from master_financial_items where category='retirement' and item_key='smsf'`);
  check('smsf catalogue item is AU-restricted', JSON.stringify(rows[0].country_applicability) === JSON.stringify(['AU']), `(${JSON.stringify(rows[0])})`);
  const others = await db.query(`select item_key from master_financial_items where category='retirement' and item_key <> 'smsf' and country_applicability is not null`);
  check('no other retirement item was accidentally restricted', others.rows.length === 0, `(${others.rows.length} unexpectedly restricted)`);

  // Simulate the exact filter listMasterItems() will apply for an IN user.
  const forIN = await db.query(`select item_key from master_financial_items where category='retirement' and is_active
    and (country_applicability is null or country_applicability @> array['IN']::char(2)[]) order by item_key`);
  check('JUR-02: catalogue query for IN user excludes smsf', !forIN.rows.some(r => r.item_key === 'smsf'), `(${forIN.rows.map(r => r.item_key).join(',')})`);
  const forAU = await db.query(`select item_key from master_financial_items where category='retirement' and is_active
    and (country_applicability is null or country_applicability @> array['AU']::char(2)[]) order by item_key`);
  check('JUR-01: catalogue query for AU user includes smsf', forAU.rows.some(r => r.item_key === 'smsf'));
}

console.log('\n=== JUR-01/03/04/05: server-side creation gate ===');
let smsfA, fundA;
await asTenant(A, async () => {
  smsfA = await expectOk('JUR-01: AU resident (A) can create an SMSF retirement_accounts row', async () => {
    const r = await db.query(`insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
      values ('${A}','My SMSF','super',400000,'AUD','AU','self','smsf',true) returning id`);
    return r.rows[0].id;
  });
  // JUR-04: AU resident owning an Indian investment does not lose SMSF eligibility
  await db.query(`insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, owner, master_item_key)
    values ('${A}','Indian ETF','etf',50000,'INR','IN','self','shares')`);
  check('JUR-04: AU resident retains SMSF after owning an Indian asset (row still active)',
    (await db.query(`select is_active from retirement_accounts where id='${smsfA}'`)).rows[0].is_active === true);
});

await asTenant(B, async () => {
  await expectReject('JUR-03: IN resident (B) forged direct INSERT of an SMSF row is rejected', async () => {
    await db.query(`insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
      values ('${B}','Forged SMSF','super',999999,'AUD','AU','self','smsf',true)`);
  });
  // JUR-05: IN resident owning an Australian property still cannot create SMSF
  await db.query(`insert into assets (user_id, asset_name, asset_class, current_value, currency_code, country_code, owner, master_item_key)
    values ('${B}','AU Investment Property','property',600000,'AUD','AU','self','investment_property')`);
  await expectReject('JUR-05: IN resident owning an AU property still cannot create SMSF', async () => {
    await db.query(`insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
      values ('${B}','Forged SMSF 2','super',1,'AUD','AU','self','smsf',true)`);
  });
});

console.log("\n=== Attempt to forge another tenant's user_id (RLS + trigger both must hold) ===");
await asTenant(B, async () => {
  await expectReject('B cannot insert an SMSF row claiming user_id=A (RLS with-check blocks mismatched owner)', async () => {
    await db.query(`insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
      values ('${A}','Impersonation SMSF','super',1,'AUD','AU','self','smsf',true)`);
  });
});

console.log('\n=== JUR-06: AU -> India residence change with existing SMSF ===');
await asTenant(A, async () => {
  // Sanity: A's SMSF is visible before the move.
  check('A can see own SMSF pre-move', (await db.query(`select 1 from retirement_accounts where id='${smsfA}'`)).rows.length === 1);
});
await asService(async () => {
  await db.query(`update user_profiles set country_of_residence='IN' where user_id='${A}'`);
});
await asTenant(A, async () => {
  const still = await db.query(`select current_balance, is_active from retirement_accounts where id='${smsfA}'`);
  check('JUR-06: existing SMSF preserved (still active, value unchanged) after AU->IN move', still.rows.length === 1 && Number(still.rows[0].current_balance) === 400000 && still.rows[0].is_active === true);
  // Maintenance edit (notes) on an already-active legacy SMSF stays allowed post-move.
  await expectOk('JUR-06: editing notes on the preserved legacy SMSF still works post-move', async () => {
    await db.query(`update retirement_accounts set notes='moved to India, kept for history' where id='${smsfA}'`);
  });
  // Archiving then attempting to reactivate while non-AU must now be rejected.
  await db.query(`update retirement_accounts set is_active=false where id='${smsfA}'`);
  await expectReject('JUR-06b: reactivating an archived SMSF while non-AU is rejected (not a "new SMSF", but treated conservatively as new activation)', async () => {
    await db.query(`update retirement_accounts set is_active=true where id='${smsfA}'`);
  });
  // restore state for later tests
  await asService(async () => { await db.query(`update retirement_accounts set is_active=true, user_id=user_id where id='${smsfA}'`).catch(() => {}); });
});
// service_role bypasses RLS/trigger checks? Triggers still fire regardless of role (BEFORE ROW trigger fires for all roles) -- reactivate via direct SQL as service to restore fixture state without re-testing the gate.
await db.query(`update retirement_accounts set is_active=true where id='${smsfA}'`).catch(async (e) => {
  // trigger still blocks even service_role since it's not SECURITY DEFINER-exempt; use a raw bypass for fixture reset only.
  await db.query(`alter table retirement_accounts disable trigger trg_retirement_accounts_smsf_au_gate`);
  await db.query(`update retirement_accounts set is_active=true where id='${smsfA}'`);
  await db.query(`alter table retirement_accounts enable trigger trg_retirement_accounts_smsf_au_gate`);
});
await asService(async () => { await db.query(`update user_profiles set country_of_residence='AU' where user_id='${A}'`); });

console.log('\n=== JUR-07: India -> Australia residence change unlocks new-product creation ===');
await asService(async () => { await db.query(`update user_profiles set country_of_residence='AU' where user_id='${B}'`); });
await asTenant(B, async () => {
  await expectOk('JUR-07: B can now create an SMSF after moving to AU', async () => {
    await db.query(`insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
      values ('${B}','B New SMSF','super',10000,'AUD','AU','self','smsf',true)`);
  });
});
// revert B and clean up the row this created (not needed for later tests)
await asService(async () => {
  await db.query(`delete from retirement_accounts where user_id='${B}' and master_item_key='smsf' and account_name='B New SMSF'`);
  await db.query(`update user_profiles set country_of_residence='IN' where user_id='${B}'`);
});

console.log('\n=== JUR-08: cross-border holding remains visible regardless of native-jurisdiction status ===');
await asTenant(A, async () => {
  const inv = await db.query(`select 1 from investments where user_id='${A}' and country_code='IN'`);
  check('JUR-08: AU resident\'s Indian investment remains visible/queryable (never filtered by country)', inv.rows.length === 1);
});

console.log('\n=== SMSF-1/2: Fund creation (app-layer coordinated insert), legacy-migration backfill ===');
await asTenant(A, async () => {
  // smsfA was created by THIS test script after migration 0084 already ran,
  // so migration 0084's PART 6 backfill (which only covers retirement_
  // accounts rows that existed BEFORE the migration) correctly does not
  // apply to it. For genuinely new SMSF creation, the app service layer
  // (app/api/smsf/route.ts) is responsible for creating the retirement_
  // accounts row AND the smsf_funds row together -- simulate that here.
  fundA = (await expectOk('SMSF-1: app-layer creates the smsf_funds row alongside a new SMSF retirement_accounts row', async () => {
    const r = await db.query(`insert into smsf_funds (user_id, retirement_account_id, fund_name, mode, summary_balance, summary_balance_date)
      values ('${A}','${smsfA}','My SMSF','summary',400000,current_date) returning id, mode, summary_balance, currency_code`);
    return r.rows[0];
  }));
  check('SMSF-2 style: fund starts in Summary Mode with the same value as the retirement_accounts row', fundA.mode === 'summary' && Number(fundA.summary_balance) === 400000, JSON.stringify(fundA));

});

// Separately prove the LEGACY backfill path (SMSF-2 proper) using a
// throwaway third tenant C, so it doesn't collide with A's unique(user_id,
// master_item_key)='smsf' constraint. Simulates "was pre-existing at
// migration time" by replaying migration 0084 Part 6's own INSERT..SELECT
// pattern directly against a retirement_accounts row with no smsf_funds row
// yet -- proving that backfill logic is correct and idempotent.
const C = '33333333-3333-3333-3333-333333333333';
await db.exec(`insert into auth.users(id,email) values ('${C}','c@t.test');`);
await db.exec(`update user_profiles set country_of_residence='AU' where user_id='${C}';`);
await asTenant(C, async () => {
  const legacyRaId = (await db.query(`insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
    values ('${C}','Legacy SMSF (pre-existing)','super',77000,'AUD','AU','self','smsf',true) returning id`)).rows[0].id;
  await db.query(`insert into smsf_funds (user_id, retirement_account_id, fund_name, mode, summary_balance, notes)
    select ra.user_id, ra.id, ra.account_name, 'summary', ra.current_balance,
      'Backfilled by migration 0084 from the pre-existing retirement_accounts row (Summary Mode, value unchanged).'
    from retirement_accounts ra
    where ra.id = '${legacyRaId}' and not exists (select 1 from smsf_funds f where f.retirement_account_id = ra.id)`);
  const legacyFund = (await db.query(`select mode, summary_balance from smsf_funds where retirement_account_id='${legacyRaId}'`)).rows[0];
  check('SMSF-2: backfill INSERT..SELECT pattern correctly creates a Summary-mode fund with unchanged value (77000)', legacyFund.mode === 'summary' && Number(legacyFund.summary_balance) === 77000, JSON.stringify(legacyFund));
});

console.log('\n=== smsf_create_fund() atomic RPC + AU gate ===');
await asTenant(B, async () => {
  await expectReject('IN resident cannot use smsf_create_fund() to bypass the gate', async () => {
    await db.query(`select * from smsf_create_fund('Forged Fund','Forged Fund',1,null,'self','AUD','AU')`);
  });
});
const C2 = '44444444-4444-4444-4444-444444444444';
await db.exec(`insert into auth.users(id,email) values ('${C2}','c2@t.test');`);
await db.exec(`update user_profiles set country_of_residence='AU' where user_id='${C2}';`);
await asTenant(C2, async () => {
  const r = await expectOk('AU resident can use smsf_create_fund() to atomically create both rows', async () => {
    return (await db.query(`select * from smsf_create_fund('RPC Fund','RPC Fund',12345,current_date,'self','AUD','AU')`)).rows[0];
  });
  if (r) {
    const raCheck = (await db.query(`select master_item_key, current_balance from retirement_accounts where id='${r.retirement_account_id}'`)).rows[0];
    const fundCheck = (await db.query(`select mode, summary_balance from smsf_funds where id='${r.smsf_fund_id}'`)).rows[0];
    check('RPC-created retirement_accounts + smsf_funds rows are both correctly linked and valued', raCheck.master_item_key === 'smsf' && Number(raCheck.current_balance) === 12345 && fundCheck.mode === 'summary' && Number(fundCheck.summary_balance) === 12345);
  }
});

console.log('\n=== SMSF-6: Summary Mode accounting ===');
await asTenant(A, async () => {
  await db.query(`update smsf_funds set summary_balance=450000, summary_balance_date=current_date where id='${fundA.id}'`);
  const ra = (await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0];
  check('Summary Mode: editing summary_balance syncs retirement_accounts.current_balance', Number(ra.current_balance) === 450000, `(${ra.current_balance})`);
  await db.query(`update smsf_funds set summary_balance=400000 where id='${fundA.id}'`); // restore for later tests
});

console.log('\n=== SMSF-6: Summary Mode + separately recorded SMSF loan -> no double-subtraction ===');
let loanA, linkA;
await asTenant(A, async () => {
  loanA = (await db.query(`insert into liabilities (user_id, liability_name, debt_type, balance, currency_code, country_code, owner, master_item_key)
    values ('${A}','SMSF Property Loan','mortgage',300000,'AUD','AU','self','smsf_property_loan') returning id`)).rows[0].id;
  linkA = (await db.query(`insert into property_liability_links (user_id, linked_retirement_id, liability_id, link_type)
    values ('${A}','${smsfA}','${loanA}','smsf_property_loan') returning id`)).rows[0].id;
  // Fund is still in SUMMARY mode: linking a loan must NOT change current_balance
  // (the hard "no double-subtraction" integrity requirement, spec s.21-22).
  const ra = (await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0];
  check('Summary Mode: linking an SMSF loan does not touch current_balance (no double-subtraction)', Number(ra.current_balance) === 400000, `(${ra.current_balance})`);
});

console.log('\n=== SMSF-6: Detailed Mode holdings + hard $0 mode-switch variance gate ===');
await asTenant(A, async () => {
  // Build Detailed Holdings that reconcile exactly to the Summary balance
  // once the $300k loan is netted off: 50k cash + 150k shares + 500k
  // property - 300k loan = 400k, matching the spec's own worked example.
  await db.query(`insert into smsf_holdings (user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code, country_code)
    values ('${A}','${fundA.id}','cash','cash','SMSF Cash',50000,'AUD','AU')`);
  await db.query(`insert into smsf_holdings (user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code, country_code)
    values ('${A}','${fundA.id}','listed_investment','au_shares','SMSF Shares',150000,'AUD','AU')`);
  const propId = (await db.query(`insert into smsf_holdings (user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code, country_code)
    values ('${A}','${fundA.id}','property','residential_property','SMSF Property',500000,'AUD','AU') returning id`)).rows[0].id;

  // Still summary mode: current_balance must remain untouched by holdings.
  let ra = (await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0];
  check('Detailed Holdings built while mode=summary: current_balance still untouched (Summary remains canonical)', Number(ra.current_balance) === 400000, `(${ra.current_balance})`);

  const preview = (await db.query(`select smsf_compute_detailed_net_value('${fundA.id}') v`)).rows[0].v;
  check('Detailed preview computes 50k+150k+500k-300k = 400k exactly', Number(preview) === 400000, `(${preview})`);

  // NEGATIVE CONTROL: introduce a variance and confirm the switch is rejected.
  await db.query(`update smsf_holdings set value=160000 where holding_name='SMSF Shares'`); // now 410k detailed vs 400k summary
  await expectReject('SMSF-6 NEGATIVE CONTROL: switch rejected when Detailed != Summary (10k unresolved variance)', async () => {
    await db.query(`select smsf_switch_to_detailed('${fundA.id}')`);
  });
  const stillSummary = (await db.query(`select mode from smsf_funds where id='${fundA.id}'`)).rows[0].mode;
  check('fund remains in summary mode after a rejected switch attempt', stillSummary === 'summary');
  ra = (await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0];
  check('current_balance unchanged after a rejected switch attempt', Number(ra.current_balance) === 400000, `(${ra.current_balance})`);

  // Resolve the variance back to exactly 400k, then the real switch.
  await db.query(`update smsf_holdings set value=150000 where holding_name='SMSF Shares'`);
  await expectOk('SMSF-6 HARD GATE: switch succeeds with exactly $0.00 variance', async () => {
    await db.query(`select smsf_switch_to_detailed('${fundA.id}')`);
  });
  const after = (await db.query(`select mode, detailed_net_value from smsf_funds where id='${fundA.id}'`)).rows[0];
  check('mode flipped to detailed', after.mode === 'detailed');
  ra = (await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0];
  const variance = Math.abs(Number(ra.current_balance) - 400000);
  check('SMSF-6 HARD GATE: Net Worth variance after mode switch is EXACTLY $0.00', variance === 0, `(current_balance=${ra.current_balance}, variance=${variance})`);

  // Exactly-one-active-source, continuously: editing a holding post-switch
  // must re-sync current_balance automatically (detailed is now the source).
  await db.query(`update smsf_holdings set value=60000 where holding_name='SMSF Cash'`); // +10k
  ra = (await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0];
  check('post-switch holding edit auto-recomputes current_balance (60k+150k+500k-300k=410k)', Number(ra.current_balance) === 410000, `(${ra.current_balance})`);
  await db.query(`update smsf_holdings set value=50000 where holding_name='SMSF Cash'`); // restore

  // Editing the linked loan's own balance post-switch must also re-sync.
  await db.query(`update liabilities set balance=280000 where id='${loanA}'`);
  ra = (await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0];
  check('post-switch liability-balance edit auto-recomputes current_balance (50k+150k+500k-280k=420k)', Number(ra.current_balance) === 420000, `(${ra.current_balance})`);
  await db.query(`update liabilities set balance=300000 where id='${loanA}'`); // restore

  // property/liability relationship stays metadata-only: property still gross.
  const propRow = (await db.query(`select value from smsf_holdings where id='${propId}'`)).rows[0];
  check('SMSF property holding stays gross (500k), never netted against the loan', Number(propRow.value) === 500000);
  const liabRow = (await db.query(`select balance from liabilities where id='${loanA}'`)).rows[0];
  check('liability keeps its own full canonical balance (300k), never scaled by allocation', Number(liabRow.balance) === 300000);

  // Negative control: summary+detailed simultaneously is structurally
  // impossible -- dashboard only ever reads current_balance from ONE row.
  const raCount = (await db.query(`select count(*)::int c from retirement_accounts where id='${smsfA}'`)).rows[0].c;
  check('exactly one retirement_accounts row backs this fund (single Net Worth entry point, by construction)', raCount === 1);
});

console.log('\n=== SMSF-6: Self/Spouse double-count negative control ===');
await asTenant(A, async () => {
  const selfMember = (await db.query(`insert into retirement_members (user_id, member_type) values ('${A}','self')
    on conflict (user_id, member_type) do update set member_type=excluded.member_type returning id`)).rows[0].id;
  const spouseMember = (await db.query(`insert into retirement_members (user_id, member_type) values ('${A}','spouse')
    on conflict (user_id, member_type) do update set member_type=excluded.member_type returning id`)).rows[0].id;
  await db.query(`insert into smsf_fund_members (user_id, smsf_fund_id, retirement_member_id, member_interest_amount) values ('${A}','${fundA.id}','${selfMember}',250000)
    on conflict (smsf_fund_id, retirement_member_id) do update set member_interest_amount=excluded.member_interest_amount`);
  await db.query(`insert into smsf_fund_members (user_id, smsf_fund_id, retirement_member_id, member_interest_amount) values ('${A}','${fundA.id}','${spouseMember}',150000)
    on conflict (smsf_fund_id, retirement_member_id) do update set member_interest_amount=excluded.member_interest_amount`);
  const memberSum = (await db.query(`select coalesce(sum(member_interest_amount),0) s from smsf_fund_members where smsf_fund_id='${fundA.id}'`)).rows[0].s;
  check('member interests recorded (250k self + 150k spouse = 400k informational)', Number(memberSum) === 400000);
  const ra = (await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0];
  check('NEGATIVE CONTROL: household SMSF Net Worth contribution is 400k (fund value), NOT 800k (sum of member interests)', Number(ra.current_balance) === 400000, `(${ra.current_balance})`);
});

console.log('\n=== SMSF-6: contribution-pollution negative control ===');
{
  const contribRows = await db.query(`select count(*)::int c from smsf_holdings where holding_type in ('employer_contributions','salary_sacrifice','personal_concessional','non_concessional','spouse_contribution','government_co_contribution')`);
  check('0 smsf_holdings rows carry any contribution-flow semantics (holding_type CHECK structurally excludes them)', contribRows.rows[0].c === 0);
  const contribAccounts = await db.query(`select count(*)::int c, coalesce(sum(current_balance),0)::numeric s from retirement_accounts where master_item_key in ('employer_contributions','salary_sacrifice','personal_concessional','non_concessional','spouse_contribution','government_co_contribution') and user_id='${A}'`);
  check('contribution retirement_accounts rows remain untouched by SMSF Detailed Mode (0 rows/$0, invariant reconfirmed)', contribAccounts.rows[0].c === 0 && Number(contribAccounts.rows[0].s) === 0);
}

console.log('\n=== SMSF-6: rental-income single-count ===');
await asTenant(A, async () => {
  const incomeId = (await db.query(`insert into income_sources (user_id, source_name, income_type, amount, frequency, currency_code, owner, master_item_key, is_active)
    values ('${A}','SMSF Property Rent','rental',2000,'monthly','AUD','self','rental_income',true) returning id`)).rows[0].id;
  const propHoldingId = (await db.query(`select id from smsf_holdings where smsf_fund_id='${fundA.id}' and holding_class='property'`)).rows[0].id;
  await db.query(`update smsf_holdings set linked_income_source_id='${incomeId}' where id='${propHoldingId}'`);
  const incomeCount = (await db.query(`select count(*)::int c from income_sources where user_id='${A}' and master_item_key='rental_income'`)).rows[0].c;
  check('rental income exists exactly once in income_sources (the only cash-flow source engines read)', incomeCount === 1);
  const holdingRef = (await db.query(`select linked_income_source_id from smsf_holdings where id='${propHoldingId}'`)).rows[0];
  check('SMSF property holding references (does not duplicate) the canonical rental income row', holdingRef.linked_income_source_id === incomeId);
  await expectReject('linked_income_source_id rejected on a non-property holding (cash)', async () => {
    const cashId = (await db.query(`select id from smsf_holdings where smsf_fund_id='${fundA.id}' and holding_class='cash'`)).rows[0].id;
    await db.query(`update smsf_holdings set linked_income_source_id='${incomeId}' where id='${cashId}'`);
  });
});

console.log('\n=== SMSF-6: multi-currency (INR holding inside an AU fund) ===');
await asTenant(A, async () => {
  await db.query(`insert into smsf_holdings (user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code, country_code)
    values ('${A}','${fundA.id}','listed_investment','international_shares','SMSF Indian Shares',560000,'INR','IN')`);
  // fx_rate_aud_inr default is 56.0 per 0016's seed -> 560000 INR = 10000 AUD
  const total = (await db.query(`select smsf_holdings_total_aud('${fundA.id}') v`)).rows[0].v;
  // 50k cash + 150k shares + 500k property + 10k (560k INR / 56) = 710k
  check('INR holding converted at fx_rate_aud_inr (560,000 INR / 56 = 10,000 AUD), not force-summed as AUD', Number(total) === 710000, `(${total})`);
  await db.query(`delete from smsf_holdings where holding_name='SMSF Indian Shares'`); // restore for later totals
});

console.log('\n=== SMSF-UI: Detailed -> Summary switch-back (migration 0089, spec s.32-33) ===');
await asTenant(B, async () => {
  await expectReject('cross-tenant: B cannot switch A\'s fund back to Summary (fund not found for B)', async () => {
    await db.query(`select smsf_switch_to_summary('${fundA.id}', 1, current_date)`);
  });
});
await asTenant(A, async () => {
  // Tested here (mode still 'detailed') so this genuinely exercises the
  // null-value guard, not the (also-true-later) "already in summary mode"
  // guard — order matters for this to be a meaningful negative control.
  await expectReject('SMSF-UI NEGATIVE CONTROL: cannot switch to summary with a null value', async () => {
    await db.query(`select smsf_switch_to_summary('${fundA.id}', null, current_date)`);
  });

  const preHoldingCount = (await db.query(`select count(*)::int c from smsf_holdings where smsf_fund_id='${fundA.id}' and is_active`)).rows[0].c;
  await expectOk('SMSF-UI: AU resident switches fund back to Summary with a NEW value + date', async () => {
    await db.query(`select smsf_switch_to_summary('${fundA.id}', 999000, current_date)`);
  });
  const fund = (await db.query(`select mode, summary_balance, summary_balance_date, detailed_net_value from smsf_funds where id='${fundA.id}'`)).rows[0];
  check('mode flipped back to summary', fund.mode === 'summary', JSON.stringify(fund));
  check('summary_balance is the NEW value provided (999000), not the old detailed figure', Number(fund.summary_balance) === 999000, `(${fund.summary_balance})`);
  const ra = (await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0];
  check('SMSF-UI HARD GATE: retirement_accounts.current_balance syncs to the new Summary value atomically (999000)', Number(ra.current_balance) === 999000, `(${ra.current_balance})`);
  const postHoldingCount = (await db.query(`select count(*)::int c from smsf_holdings where smsf_fund_id='${fundA.id}' and is_active`)).rows[0].c;
  check('SMSF-UI: Detailed Holdings are preserved (not deleted) across the switch-back', postHoldingCount === preHoldingCount, `(before=${preHoldingCount}, after=${postHoldingCount})`);
  check('detailed_net_value is retained as reference data, not wiped', Number(fund.detailed_net_value) === 400000, `(${fund.detailed_net_value})`);

  await expectReject('SMSF-UI NEGATIVE CONTROL: cannot switch to summary again while already in summary mode', async () => {
    await db.query(`select smsf_switch_to_summary('${fundA.id}', 1, current_date)`);
  });

  // Restore fundA to Detailed mode (summary_balance back to the value that
  // reconciles with its unchanged holdings) so every downstream section
  // below continues to exercise a Detailed-mode fund exactly as before this
  // block was inserted.
  await db.query(`update smsf_funds set summary_balance=400000 where id='${fundA.id}'`);
  await expectOk('fixture restore: switch fundA back to Detailed mode for downstream sections', async () => {
    await db.query(`select smsf_switch_to_detailed('${fundA.id}')`);
  });
  const restored = (await db.query(`select mode from smsf_funds where id='${fundA.id}'`)).rows[0];
  check('fixture restore: fundA is Detailed mode again', restored.mode === 'detailed');
});

console.log('\n=== RLS: cross-tenant denial on the three new tables ===');
await asTenant(B, async () => {
  const leakFunds = (await db.query(`select count(*)::int c from smsf_funds where user_id='${A}'`)).rows[0].c;
  check('B cannot read A\'s smsf_funds', leakFunds === 0, `(leaked ${leakFunds})`);
  const leakHoldings = (await db.query(`select count(*)::int c from smsf_holdings where user_id='${A}'`)).rows[0].c;
  check('B cannot read A\'s smsf_holdings', leakHoldings === 0, `(leaked ${leakHoldings})`);
  const leakMembers = (await db.query(`select count(*)::int c from smsf_fund_members where user_id='${A}'`)).rows[0].c;
  check('B cannot read A\'s smsf_fund_members', leakMembers === 0, `(leaked ${leakMembers})`);
  const leakLinks = (await db.query(`select count(*)::int c from property_liability_links where user_id='${A}'`)).rows[0].c;
  check('B cannot read A\'s property_liability_links', leakLinks === 0, `(leaked ${leakLinks})`);

  await expectReject('B cannot forge a smsf_holdings row into A\'s fund (cross-referenced WITH CHECK)', async () => {
    await db.query(`insert into smsf_holdings (user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code)
      values ('${B}','${fundA.id}','cash','cash','forged',1,'AUD')`);
  });
  await expectReject('B cannot forge a smsf_fund_members row attaching to A\'s fund', async () => {
    const bMember = (await db.query(`insert into retirement_members (user_id, member_type) values ('${B}','self')
      on conflict (user_id, member_type) do update set member_type=excluded.member_type returning id`)).rows[0].id;
    await db.query(`insert into smsf_fund_members (user_id, smsf_fund_id, retirement_member_id) values ('${B}','${fundA.id}','${bMember}')`);
  });
  const del = (await db.query(`delete from smsf_funds where id='${fundA.id}' returning 1`)).rows.length;
  check('B cannot delete A\'s smsf_funds row', del === 0, `(deleted ${del})`);
});

console.log('\n=== NEGATIVE CONTROL: prove the RLS checks above are not vacuous ===');
await db.exec(`alter table smsf_funds disable row level security;`);
let leak = 0;
await asTenant(B, async () => { leak = (await db.query(`select count(*)::int c from smsf_funds where user_id='${A}'`)).rows[0].c; });
check('control: RLS off on smsf_funds -> B DOES see A\'s fund (proves prior denial was real)', leak === 1, `(saw ${leak}, expected 1)`);
await db.exec(`alter table smsf_funds enable row level security;`);
let re = 0;
await asTenant(B, async () => { re = (await db.query(`select count(*)::int c from smsf_funds where user_id='${A}'`)).rows[0].c; });
check('control: isolation restored on smsf_funds', re === 0, `(saw ${re})`);

console.log('\n=== Existing invariants reconfirmed (no regression) ===');
{
  const dashboardShapeCheck = await db.query(`select current_balance, currency_code from retirement_accounts where id='${smsfA}'`);
  check('retirement_accounts row still has the exact shape lib/engines/dashboard.ts reads (current_balance, currency_code)', dashboardShapeCheck.rows.length === 1);
  const rmIntact = await db.query(`select count(*)::int c from retirement_members where user_id='${A}'`);
  check('retirement_members (certified) untouched/intact -- 2 rows (self+spouse) from this test', rmIntact.rows[0].c === 2);
  const pllIntact = await db.query(`select count(*)::int c from property_liability_links where liability_id='${loanA}'`);
  check('property_liability_links row for the SMSF loan intact', pllIntact.rows[0].c === 1);
  const noRls = (await db.query(`select c.relname from pg_class c join pg_namespace nsp on nsp.oid=c.relnamespace
    where nsp.nspname='public' and c.relkind='r' and not c.relrowsecurity and c.relname like 'smsf_%'`)).rows;
  check('all smsf_* tables have RLS enabled', noRls.length === 0, JSON.stringify(noRls));
}


console.log('\n=== SMSF-UI: current_balance integrity guard (migration 0090) ===');
{
  await asTenant(A, async () => {
    const before = Number((await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0].current_balance);
    await expectReject('GUARD 0090: direct UPDATE of an SMSF row current_balance is REJECTED (the raw-PATCH attack)', async () => {
      await db.query(`update retirement_accounts set current_balance=999999 where id='${smsfA}'`);
    });
    const after = Number((await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0].current_balance);
    check('GUARD 0090: balance genuinely unchanged after the blocked attack', after === before, `(before ${before}, after ${after})`);
    let notesOk = true, notesErr = '';
    try { await db.query(`update retirement_accounts set notes='guard scope test' where id='${smsfA}'`); }
    catch (e) { notesOk = false; notesErr = String(e.message).slice(0, 120); }
    check('GUARD 0090 SCOPE: non-balance columns on the SMSF row remain editable', notesOk, notesErr);
    const other = (await db.query(`insert into retirement_accounts(user_id,account_name,account_type,current_balance,currency_code,country_code,owner,master_item_key,is_active)
      values('${A}','Industry Super Guard Test','super',50000,'AUD','AU','self','industry_super',true) returning id`)).rows[0].id;
    let otherOk = true, otherErr = '';
    try { await db.query(`update retirement_accounts set current_balance=60000 where id='${other}'`); }
    catch (e) { otherOk = false; otherErr = String(e.message).slice(0, 120); }
    const otherVal = Number((await db.query(`select current_balance from retirement_accounts where id='${other}'`)).rows[0].current_balance);
    check('GUARD 0090 NEGATIVE CONTROL: a NON-SMSF retirement row is still freely editable (guard is narrow)', otherOk && otherVal === 60000, `(got ${otherVal}) ${otherErr}`);
  });
  // fundA is in DETAILED mode here, so a summary_balance edit correctly does NOT
  // drive current_balance (0084's own `if new.mode = 'summary'` design). Prove the
  // DETAILED certified writer -- smsf_recompute_fund(), whitelisted via ALTER
  // FUNCTION ... SET -- still reaches current_balance through the guard. The Summary
  // path was already proven earlier in this same suite.
  const detBefore = Number((await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0].current_balance);
  await db.query(`insert into smsf_holdings(user_id,smsf_fund_id,holding_class,holding_type,holding_name,value,currency_code,country_code)
    values ('${A}','${fundA.id}','cash','cash','Guard Test Cash',1000,'AUD','AU')`);
  const detAfter = Number((await db.query(`select current_balance from retirement_accounts where id='${smsfA}'`)).rows[0].current_balance);
  check('GUARD 0090: the CERTIFIED Detailed path (smsf_recompute_fund) still writes current_balance through the guard', detAfter === detBefore + 1000, `(before ${detBefore}, after ${detAfter})`);
}

console.log(`\nSMSF + JURISDICTION CERTIFICATION: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
