// FDH-15 — Bridge / Governance Certification: PGlite negative-control proof
// for the two genuine defects found and fixed during this certification pass
// (FDH15-DEF-001 Income, FDH15-DEF-002 Retirement — spec sections 30, 81,
// 120, 197). Follows the established project pattern (fdh9_certification.mjs,
// fdh12_certification.mjs): fresh rebuild of every real migration on real
// Postgres (PGlite), `set_config('request.jwt.claims', ...)` + `set role
// authenticated` to exercise the RPC exactly as PostgREST would.
//
// Each defect is proven TWICE:
//   (a) against an ISOLATED copy of the schema with migrations 0119/0120
//       excluded (migrationFilter strips them) — reproduces the ORIGINAL
//       live-DEV-observed failure, so this harness is proven to actually
//       detect the absence of the guard (spec section 65 anti-vacuity), and
//   (b) against the full current chain (0119/0120 included) — proves the fix
//       blocks it, with a positive control proving the fix does not
//       over-block legitimate same-member applies.
//
// Usage: node scripts/fdh15_member_mismatch_pglite_certification.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const SHIM = path.join(HERE, 'db-rebuild-check', 'shim.sql');
const SEED = path.join(ROOT, 'seed.sql');

const A = '11111111-1111-1111-1111-111111111111';

let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label} ${detail}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

async function buildDb(migrationFilter = (_f, sql) => sql, excludeFiles = []) {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(SEED, 'utf8');
  const files = fs.readdirSync(MIG).filter((x) => x.endsWith('.sql') && !excludeFiles.includes(x)).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8')
      .replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
    await db.exec(migrationFilter(f, sql));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  return db;
}
async function asRole(db, role, uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role })]);
  await db.exec(`set role ${role};`);
  try { return await fn(); } finally {
    await db.exec(`reset role;`);
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}
async function seedTenant(db, uid) {
  await db.exec(`insert into auth.users(id,email) values ('${uid}','${uid}@t.test') on conflict do nothing;`);
  await db.query(
    `insert into user_profiles(user_id, country_of_residence, country_confirmed_at, country_source)
     values ($1,'AU', now(), 'USER_CONFIRMED')
     on conflict (user_id) do update set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED'`,
    [uid],
  );
}

// ===========================================================================
// FDH15-DEF-001 — Income Self/Spouse target forgery
// ===========================================================================
async function incomeScenario(db) {
  await seedTenant(db, A);
  const selfIncome = (await db.query(
    `insert into income_sources (user_id, source_name, income_type, amount, frequency, currency_code, employer_name, owner)
     values ($1,'Self salary','salary',4000,'monthly','AUD','Acme Pty Ltd','self') returning id`, [A],
  )).rows[0].id;
  const spouseIncome = (await db.query(
    `insert into income_sources (user_id, source_name, income_type, amount, frequency, currency_code, employer_name, owner)
     values ($1,'Spouse salary','salary',3500,'monthly','AUD','Acme Pty Ltd','spouse') returning id`, [A],
  )).rows[0].id;
  const payrollEvent = (await db.query(
    `insert into fdh_payroll_events (user_id, employer_name, country_code, currency_code, gross_pay, net_pay)
     values ($1,'Acme Pty Ltd','AU','AUD',4700,4200) returning id`, [A],
  )).rows[0].id;
  // Proposal deliberately (mis)targets the SPOUSE-owned row from Self's payslip.
  const prop = (await db.query(
    `insert into fhip_import_proposals (user_id, target_domain, source_kind, source_payroll_event_id, currency_code, target_entity_id, recommended_apply_mode, status)
     values ($1,'income','payslip',$2,'AUD',$3,'update_existing','ready') returning id`,
    [A, payrollEvent, spouseIncome],
  )).rows[0].id;
  await db.query(
    `insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value, existing_value)
     values ($1,$2,'amount','money','9000.00','3500.00')`, [A, prop],
  );
  const result = await asRole(db, 'authenticated', A, async () => {
    const r = await db.query(`select fdh9_apply_income_proposal($1,'update_existing',array['amount']) as result`, [prop]);
    return r.rows[0].result;
  });
  const spouseAfter = (await db.query(`select amount from income_sources where id=$1`, [spouseIncome])).rows[0].amount;
  return { result, spouseIncome, selfIncome, spouseAfter };
}

async function incomePositiveControl(db) {
  await seedTenant(db, A);
  const selfIncome = (await db.query(
    `insert into income_sources (user_id, source_name, income_type, amount, frequency, currency_code, employer_name, owner)
     values ($1,'Self salary','salary',4000,'monthly','AUD','Acme Pty Ltd','self') returning id`, [A],
  )).rows[0].id;
  const payrollEvent = (await db.query(
    `insert into fdh_payroll_events (user_id, employer_name, country_code, currency_code, gross_pay, net_pay)
     values ($1,'Acme Pty Ltd','AU','AUD',4700,4200) returning id`, [A],
  )).rows[0].id;
  const prop = (await db.query(
    `insert into fhip_import_proposals (user_id, target_domain, source_kind, source_payroll_event_id, currency_code, target_entity_id, recommended_apply_mode, status)
     values ($1,'income','payslip',$2,'AUD',$3,'update_existing','ready') returning id`,
    [A, payrollEvent, selfIncome],
  )).rows[0].id;
  await db.query(
    `insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value, existing_value)
     values ($1,$2,'amount','money','4200.00','4000.00')`, [A, prop],
  );
  const result = await asRole(db, 'authenticated', A, async () => {
    const r = await db.query(`select fdh9_apply_income_proposal($1,'update_existing',array['amount']) as result`, [prop]);
    return r.rows[0].result;
  });
  return result;
}

// ===========================================================================
// FDH15-DEF-002 — Retirement Self/Spouse target forgery
// ===========================================================================
async function retirementScenario(db) {
  await seedTenant(db, A);
  const selfMember = (await db.query(`insert into retirement_members (user_id, member_type, country_code) values ($1,'self','AU') returning id`, [A])).rows[0].id;
  const spouseMember = (await db.query(`insert into retirement_members (user_id, member_type, country_code) values ($1,'spouse','AU') returning id`, [A])).rows[0].id;
  const selfAcct = (await db.query(
    `insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, is_active, owner, retirement_member_id)
     values ($1,'Self Super','super',100000,'AUD',true,'self',$2) returning id`, [A, selfMember],
  )).rows[0].id;
  const spouseAcct = (await db.query(
    `insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, is_active, owner, retirement_member_id)
     values ($1,'Spouse Super','super',80000,'AUD',true,'spouse',$2) returning id`, [A, spouseMember],
  )).rows[0].id;
  const stmt = (await db.query(
    `insert into fdh_retirement_statements (user_id, retirement_member_id, canonical_account_id, statement_type, retirement_jurisdiction, account_type, currency_code, closing_balance, reconciliation_status, review_status, approval_status, extraction_status)
     values ($1,$2,$3,'super_member_statement','AU','industry_super','AUD',999000,'reconciled','resolved','approved','extracted') returning id`,
    [A, selfMember, selfAcct],
  )).rows[0].id;
  // Proposal deliberately (mis)targets the SPOUSE account from a Self-member statement.
  const prop = (await db.query(
    `insert into fhip_import_proposals (user_id, target_domain, source_kind, source_retirement_statement_id, currency_code, target_entity_id, recommended_apply_mode, status)
     values ($1,'retirement','retirement_statement',$2,'AUD',$3,'update_existing','ready') returning id`,
    [A, stmt, spouseAcct],
  )).rows[0].id;
  await db.query(
    `insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value, existing_value)
     values ($1,$2,'current_balance','money','999000.00','80000.00')`, [A, prop],
  );
  const result = await asRole(db, 'authenticated', A, async () => {
    const r = await db.query(`select fdh12_apply_retirement_proposal($1,'update_existing',array['current_balance']) as result`, [prop]);
    return r.rows[0].result;
  });
  const spouseAfter = (await db.query(`select current_balance from retirement_accounts where id=$1`, [spouseAcct])).rows[0].current_balance;
  return { result, spouseAcct, spouseAfter };
}

async function retirementPositiveControl(db) {
  await seedTenant(db, A);
  const selfMember = (await db.query(`insert into retirement_members (user_id, member_type, country_code) values ($1,'self','AU') returning id`, [A])).rows[0].id;
  const selfAcct = (await db.query(
    `insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, is_active, owner, retirement_member_id)
     values ($1,'Self Super','super',100000,'AUD',true,'self',$2) returning id`, [A, selfMember],
  )).rows[0].id;
  const stmt = (await db.query(
    `insert into fdh_retirement_statements (user_id, retirement_member_id, canonical_account_id, statement_type, retirement_jurisdiction, account_type, currency_code, closing_balance, reconciliation_status, review_status, approval_status, extraction_status)
     values ($1,$2,$3,'super_member_statement','AU','industry_super','AUD',105000,'reconciled','resolved','approved','extracted') returning id`,
    [A, selfMember, selfAcct],
  )).rows[0].id;
  const prop = (await db.query(
    `insert into fhip_import_proposals (user_id, target_domain, source_kind, source_retirement_statement_id, currency_code, target_entity_id, recommended_apply_mode, status)
     values ($1,'retirement','retirement_statement',$2,'AUD',$3,'update_existing','ready') returning id`,
    [A, stmt, selfAcct],
  )).rows[0].id;
  await db.query(
    `insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value, existing_value)
     values ($1,$2,'current_balance','money','105000.00','100000.00')`, [A, prop],
  );
  const result = await asRole(db, 'authenticated', A, async () => {
    const r = await db.query(`select fdh12_apply_retirement_proposal($1,'update_existing',array['current_balance']) as result`, [prop]);
    return r.rows[0].result;
  });
  return result;
}

async function main() {
  console.log('=== FDH-15 Member-Mismatch Guard: PGlite anti-vacuity + fix certification ===\n');

  console.log('--- ANTI-VACUITY: reproduce the ORIGINAL (pre-fix) failure on an isolated schema copy ---');
  {
    const dbOld = await buildDb(undefined, ['0119_fdh15_retirement_member_mismatch_guard.sql', '0120_fdh15_income_member_mismatch_guard.sql']);
    const inc = await incomeScenario(dbOld);
    check('HARNESS ANTI-VACUITY (Income): WITHOUT 0120, the forged Self->Spouse apply SUCCEEDS (proves this harness genuinely detects the guard\'s absence)', inc.result?.ok === true && Number(inc.spouseAfter) === 9000, JSON.stringify(inc.result));
    const dbOld2 = await buildDb(undefined, ['0119_fdh15_retirement_member_mismatch_guard.sql', '0120_fdh15_income_member_mismatch_guard.sql']);
    const ret = await retirementScenario(dbOld2);
    check('HARNESS ANTI-VACUITY (Retirement): WITHOUT 0119, the forged Self->Spouse apply SUCCEEDS (proves this harness genuinely detects the guard\'s absence)', ret.result?.ok === true && Number(ret.spouseAfter) === 999000, JSON.stringify(ret.result));
  }

  console.log('\n--- FIX VERIFICATION: full current migration chain (0119 + 0120 included) ---');
  {
    const db = await buildDb();
    const inc = await incomeScenario(db);
    check('FDH15-DEF-001 FIX: forged Self->Spouse income apply now BLOCKED (MEMBER_MISMATCH)', inc.result?.ok === false && inc.result?.code === 'MEMBER_MISMATCH', JSON.stringify(inc.result));
    check('FDH15-DEF-001 FIX: Spouse income amount unchanged (still 3500, not 9000)', Number(inc.spouseAfter) === 3500, `spouseAfter=${inc.spouseAfter}`);

    const incPos = await incomePositiveControl(db);
    check('FDH15-DEF-001 POSITIVE CONTROL: legitimate Self->Self apply still succeeds (fix is not over-broad)', incPos?.ok === true, JSON.stringify(incPos));

    const db2 = await buildDb();
    const ret = await retirementScenario(db2);
    check('FDH15-DEF-002 FIX: forged Self->Spouse retirement apply now BLOCKED (MEMBER_MISMATCH)', ret.result?.ok === false && ret.result?.code === 'MEMBER_MISMATCH', JSON.stringify(ret.result));
    check('FDH15-DEF-002 FIX: Spouse retirement balance unchanged (still 80000, not 999000)', Number(ret.spouseAfter) === 80000, `spouseAfter=${ret.spouseAfter}`);

    const db3 = await buildDb();
    const retPos = await retirementPositiveControl(db3);
    check('FDH15-DEF-002 POSITIVE CONTROL: legitimate Self->Self apply still succeeds (fix is not over-broad)', retPos?.ok === true, JSON.stringify(retPos));
  }

  console.log(`\n${pass}/${pass + fail} PASS`);
  if (failures.length) { console.log('FAILURES:', failures.join(' | ')); process.exitCode = 1; }
}

main();
