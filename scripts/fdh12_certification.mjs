// FDH-12 — Retirement Statement Intelligence: PGlite-based DB-level
// certification (spec sections 96-111, 163, 165).
//
// Follows the established project pattern (scripts/fdh9_certification.mjs,
// scripts/fdh11_certification.mjs): a fresh clean rebuild of every real
// migration on real Postgres (PGlite), real multi-tenant data,
// `set_config('request.jwt.claims', ...)` + `set role <role>` to exercise
// RLS/triggers for real, and negative controls that prove every PASS above
// them is not vacuous.
//
// Covers:
//   1. Migration replay — every migration applies cleanly on an empty DB
//   2. Schema — the three FDH-12 tables exist with RLS enabled
//   3. Same-tenant authority (spec 96) — the authenticated role cannot forge
//      reconciliation_status, account_match_status, payslip_match_status,
//      approval_status, canonical_account_id or the apply provenance; the
//      service role can
//   4. Cross-tenant security (spec 97-102) — Tenant B blocked from A's
//      statements/activities/positions; ownership triggers reject forged
//      cross-tenant references to a retirement account, a retirement member,
//      a payslip and a bank transaction
//   5. Deduplication indexes (spec 51-53) — fingerprint, payroll-event and
//      bank-transaction uniqueness are real DB constraints
//   6. Apply (spec 105-110) — duplicate apply, concurrent apply, stale
//      proposal, keep-existing, forbidden field, SMSF refusal, target
//      retirement age preservation, and atomicity
//   7. Harness self-check — deliberately weaken one control, prove this
//      harness would catch it
//
// Usage: node scripts/fdh12_certification.mjs
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
const B = '22222222-2222-2222-2222-222222222222';

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${label} ${detail}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

async function buildDb(migrationFilter = (_filename, sql) => sql) {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(SEED, 'utf8');
  const files = fs.readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort();
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

async function seedTenants(db) {
  await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test');`);
  // Both tenants get a profile, a self member and one ordinary super account.
  for (const uid of [A, B]) {
    await db.query(
      `insert into retirement_members(user_id, member_type, target_retirement_age, is_active)
       values ($1,'self',67,true)`, [uid]);
    await db.query(
      `insert into retirement_accounts(user_id, account_name, account_type, current_balance,
         currency_code, country_code, owner, is_active)
       values ($1,'Hostplus Super','super',220000.00,'AUD','AU','self',true)`, [uid]);
  }
}

async function accountIdFor(db, uid) {
  const r = await db.query(`select id from retirement_accounts where user_id=$1 limit 1`, [uid]);
  return r.rows[0].id;
}
async function memberIdFor(db, uid) {
  const r = await db.query(`select id from retirement_members where user_id=$1 limit 1`, [uid]);
  return r.rows[0].id;
}

async function seedStatement(db, uid, overrides = {}) {
  const cols = {
    user_id: uid,
    statement_type: 'super_member_statement',
    retirement_jurisdiction: 'AU',
    account_type: 'industry_super',
    fund_name: 'Hostplus',
    currency_code: 'AUD',
    opening_balance: '100000.00',
    closing_balance: '113500.00',
    ...overrides,
  };
  const keys = Object.keys(cols);
  const vals = keys.map((_, i) => `$${i + 1}`);
  const r = await db.query(
    `insert into fdh_retirement_statements(${keys.join(',')}) values (${vals.join(',')}) returning id`,
    keys.map((k) => cols[k]),
  );
  return r.rows[0].id;
}

async function main() {
  console.log('FDH-12 PGlite certification\n');

  // ---------------------------------------------------------------- 1. replay
  console.log('1. MIGRATION REPLAY');
  const db = await buildDb();
  check('every migration applies cleanly on an empty database', true);
  const migCount = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).length;
  check('the chain replayed in full', migCount > 100, `(${migCount} migrations)`);

  // ---------------------------------------------------------------- 2. schema
  console.log('\n2. SCHEMA');
  const TABLES = [
    'fdh_retirement_statements',
    'fdh_retirement_statement_activities',
    'fdh_retirement_statement_positions',
  ];
  for (const t of TABLES) {
    const r = await db.query(
      `select relrowsecurity from pg_class where relname=$1 and relnamespace='public'::regnamespace`, [t]);
    check(`${t} exists with RLS enabled`, r.rows.length === 1 && r.rows[0].relrowsecurity === true);
  }
  const rpcs = await db.query(
    `select proname from pg_proc where proname in ('fdh12_apply_retirement_proposal','fdh12_approve_retirement_statement')`);
  check('both FDH-12 RPCs exist', rpcs.rows.length === 2);

  // Money columns are exact numeric, never float.
  const floatCols = await db.query(
    `select a.attname, c.relname from pg_attribute a join pg_class c on c.oid=a.attrelid
     where c.relname = any($1) and a.atttypid in ('float4'::regtype,'float8'::regtype)`, [TABLES]);
  check('no floating-point money column anywhere (spec 142)', floatCols.rows.length === 0);

  const uniq = await db.query(
    `select indexname from pg_indexes where tablename='fdh_retirement_statement_activities'
       and indexname like 'uq_%'`);
  check('the three uniqueness indexes exist (spec 51-53, 22, 38)', uniq.rows.length === 3,
    `(${uniq.rows.map((r) => r.indexname).sort().join(', ')})`);

  await seedTenants(db);
  const accA = await accountIdFor(db, A);
  const accB = await accountIdFor(db, B);
  const memA = await memberIdFor(db, A);
  const memB = await memberIdFor(db, B);
  const stmtA = await seedStatement(db, A);

  // ------------------------------------------------- 3. same-tenant authority
  console.log('\n3. SAME-TENANT AUTHORITY (spec 96)');
  const FORGE_ATTEMPTS = [
    ['reconciliation_status', `reconciliation_status='reconciled'`],
    ['account_match_status', `account_match_status='matched'`],
    ['approval_status', `approval_status='approved'`],
    ['canonical_account_id', `canonical_account_id='${accA}'`],
    ['closing_balance', `closing_balance='999999.00'`],
  ];
  // smsf_classification needs a non-default starting value: forging a column
  // to the value it ALREADY holds is a no-op, and `is distinct from` correctly
  // does not fire on it. Setting it to 'possible_smsf' first makes the forgery
  // attempt below a real state change — which is the thing that must be
  // refused (a user must not be able to clear their own SMSF routing flag).
  await asRole(db, 'service_role', A, () =>
    db.query(`update fdh_retirement_statements set smsf_classification='possible_smsf' where id=$1`, [stmtA]));
  FORGE_ATTEMPTS.push(['smsf_classification (clearing a real SMSF flag)', `smsf_classification='not_smsf'`]);
  for (const [field, setClause] of FORGE_ATTEMPTS) {
    let forged = false;
    let msg = '';
    try {
      await asRole(db, 'authenticated', A, () =>
        db.query(`update fdh_retirement_statements set ${setClause} where id=$1`, [stmtA]));
      forged = true;
    } catch (e) { msg = e.message; }
    check(`authenticated user cannot forge ${field}`,
      !forged && /system-authoritative/.test(msg), msg.slice(0, 60));
  }

  await asRole(db, 'service_role', A, () =>
    db.query(`update fdh_retirement_statements set smsf_classification='not_smsf' where id=$1`, [stmtA]));

  // POSITIVE CONTROL — the user-correctable surface really is writable, so the
  // checks above are not passing merely because all updates fail.
  let editableOk = false;
  try {
    await asRole(db, 'authenticated', A, () =>
      db.query(`update fdh_retirement_statements set nickname='My super' where id=$1`, [stmtA]));
    const r = await db.query(`select nickname from fdh_retirement_statements where id=$1`, [stmtA]);
    editableOk = r.rows[0].nickname === 'My super';
  } catch { editableOk = false; }
  check('POSITIVE CONTROL: the user CAN edit their own nickname (not all updates fail)', editableOk);

  // The service-role bridge CAN write the authoritative columns.
  await asRole(db, 'service_role', A, () =>
    db.query(`update fdh_retirement_statements set reconciliation_status='reconciled',
              account_match_status='matched', canonical_account_id=$2 where id=$1`, [stmtA, accA]));
  const svc = await db.query(
    `select reconciliation_status, account_match_status from fdh_retirement_statements where id=$1`, [stmtA]);
  check('POSITIVE CONTROL: the service-role bridge CAN write them (real path proven)',
    svc.rows[0].reconciliation_status === 'reconciled' && svc.rows[0].account_match_status === 'matched');

  // ---------------------------------------------------- 4. cross-tenant (97-102)
  console.log('\n4. CROSS-TENANT SECURITY (spec 97-102)');
  const visible = await asRole(db, 'authenticated', B, () =>
    db.query(`select id from fdh_retirement_statements where id=$1`, [stmtA]));
  check('spec 97: Tenant B cannot READ Tenant A\'s statement', visible.rows.length === 0);

  let crossWrite = false;
  try {
    await asRole(db, 'authenticated', B, () =>
      db.query(`update fdh_retirement_statements set nickname='hacked' where id=$1`, [stmtA]));
    const after = await db.query(`select nickname from fdh_retirement_statements where id=$1`, [stmtA]);
    crossWrite = after.rows[0].nickname === 'hacked';
  } catch { /* RLS filters rather than throwing */ }
  check('spec 97: Tenant B write to Tenant A\'s statement has no effect', !crossWrite);

  // spec 98 — a statement targeting ANOTHER tenant's retirement account.
  // Issued as service_role so RLS is out of the picture and the ownership
  // TRIGGER alone is under test.
  let blocked98 = false; let m98 = '';
  try {
    await asRole(db, 'service_role', A, () =>
      db.query(`update fdh_retirement_statements set canonical_account_id=$2 where id=$1`, [stmtA, accB]));
  } catch (e) { blocked98 = /cross-tenant/.test(e.message); m98 = e.message; }
  check('spec 98: foreign RETIREMENT ACCOUNT is BLOCKED', blocked98, m98.slice(0, 70));

  // spec 101 — a statement attached to another user's Self/Spouse member row.
  let blocked101 = false; let m101 = '';
  try {
    await asRole(db, 'service_role', A, () =>
      db.query(`update fdh_retirement_statements set retirement_member_id=$2 where id=$1`, [stmtA, memB]));
  } catch (e) { blocked101 = /cross-tenant/.test(e.message); m101 = e.message; }
  check('spec 101: foreign RETIREMENT MEMBER is BLOCKED', blocked101, m101.slice(0, 70));

  // POSITIVE CONTROL — the tenant's OWN member attaches fine.
  let ownMemberOk = false;
  try {
    await asRole(db, 'service_role', A, () =>
      db.query(`update fdh_retirement_statements set retirement_member_id=$2 where id=$1`, [stmtA, memA]));
    ownMemberOk = true;
  } catch { ownMemberOk = false; }
  check('POSITIVE CONTROL: the tenant\'s OWN member attaches successfully', ownMemberOk);

  // spec 100 — a foreign PAYSLIP. Needs a real payroll event for B.
  const payB = await db.query(
    `insert into fdh_payroll_events(user_id, employer_name, currency_code, country_code)
     values ($1,'Acme','AUD','AU') returning id`, [B]);
  let blocked100 = false; let m100 = '';
  try {
    await asRole(db, 'service_role', A, () =>
      db.query(`insert into fdh_retirement_statement_activities
                (user_id, statement_id, activity_type, amount, currency_code, matched_payroll_event_id)
                values ($1,$2,'EMPLOYER_CONTRIBUTION','1000.00','AUD',$3)`,
        [A, stmtA, payB.rows[0].id]));
  } catch (e) { blocked100 = /cross-tenant/.test(e.message); m100 = e.message; }
  check('spec 100: foreign PAYSLIP link is BLOCKED', blocked100, m100.slice(0, 70));

  // spec 99 — a foreign BANK TRANSACTION.
  let txnB = null;
  try {
    const acct = await db.query(
      `insert into fdh_financial_accounts(user_id, display_name, account_type, currency_code, country_code)
       values ($1,'B Everyday','transaction','AUD','AU') returning id`, [B]);
    const t = await db.query(
      `insert into fdh_transactions(user_id, financial_account_id, transaction_date,
         amount_original, currency_original, credit_debit, description_clean)
       values ($1,$2,'2026-07-15','5000.00','AUD','debit','HOSTPLUS SUPER') returning id`,
      [B, acct.rows[0].id]);
    txnB = t.rows[0].id;
  } catch (e) { console.log('    (note: could not seed a Tenant B bank transaction: ' + e.message.slice(0, 80) + ')'); }

  if (txnB) {
    let blocked99 = false; let m99 = '';
    try {
      await asRole(db, 'service_role', A, () =>
        db.query(`insert into fdh_retirement_statement_activities
                  (user_id, statement_id, activity_type, amount, currency_code, linked_transaction_id)
                  values ($1,$2,'PERSONAL_CONTRIBUTION','5000.00','AUD',$3)`, [A, stmtA, txnB]));
    } catch (e) { blocked99 = /cross-tenant/.test(e.message); m99 = e.message; }
    check('spec 99: foreign BANK TRANSACTION link is BLOCKED', blocked99, m99.slice(0, 70));
  } else {
    check('spec 99: foreign BANK TRANSACTION link is BLOCKED', false, '(could not seed fixture — NOT PROVEN)');
  }

  // A cross-tenant activity->statement reference.
  const stmtB = await seedStatement(db, B);
  let blockedStmt = false; let mStmt = '';
  try {
    await asRole(db, 'service_role', A, () =>
      db.query(`insert into fdh_retirement_statement_activities
                (user_id, statement_id, activity_type, amount, currency_code)
                values ($1,$2,'FEE','100.00','AUD')`, [A, stmtB]));
  } catch (e) { blockedStmt = /cross-tenant/.test(e.message); mStmt = e.message; }
  check('cross-tenant activity -> statement reference is BLOCKED', blockedStmt, mStmt.slice(0, 70));

  // ------------------------------------------------------------- 5. dedup
  console.log('\n5. DEDUPLICATION INDEXES (spec 51-53, 22, 38)');
  await asRole(db, 'service_role', A, () =>
    db.query(`insert into fdh_retirement_statement_activities
              (user_id, statement_id, activity_type, amount, currency_code, activity_fingerprint)
              values ($1,$2,'EMPLOYER_CONTRIBUTION','1000.00','AUD','fp-1')`, [A, stmtA]));
  let dupBlocked = false;
  try {
    await asRole(db, 'service_role', A, () =>
      db.query(`insert into fdh_retirement_statement_activities
                (user_id, statement_id, activity_type, amount, currency_code, activity_fingerprint)
                values ($1,$2,'EMPLOYER_CONTRIBUTION','1000.00','AUD','fp-1')`, [A, stmtA]));
  } catch (e) { dupBlocked = e.code === '23505' || /duplicate key/.test(e.message); }
  check('a duplicate activity fingerprint is rejected by the DB', dupBlocked);

  // NULL fingerprints must NOT collide (partial index).
  let nullsOk = true;
  try {
    for (let i = 0; i < 2; i += 1) {
      await asRole(db, 'service_role', A, () =>
        db.query(`insert into fdh_retirement_statement_activities
                  (user_id, statement_id, activity_type, amount, currency_code)
                  values ($1,$2,'FEE','10.00','AUD')`, [A, stmtA]));
    }
  } catch { nullsOk = false; }
  check('NULL fingerprints do not collide (the index is partial)', nullsOk);

  // One payslip evidences at most one fund contribution (spec 22).
  const payA = await db.query(
    `insert into fdh_payroll_events(user_id, employer_name, currency_code, country_code)
     values ($1,'Acme','AUD','AU') returning id`, [A]);
  await asRole(db, 'service_role', A, () =>
    db.query(`insert into fdh_retirement_statement_activities
              (user_id, statement_id, activity_type, amount, currency_code, matched_payroll_event_id)
              values ($1,$2,'EMPLOYER_CONTRIBUTION','1000.00','AUD',$3)`, [A, stmtA, payA.rows[0].id]));
  let payDup = false;
  try {
    await asRole(db, 'service_role', A, () =>
      db.query(`insert into fdh_retirement_statement_activities
                (user_id, statement_id, activity_type, amount, currency_code, matched_payroll_event_id)
                values ($1,$2,'EMPLOYER_CONTRIBUTION','1000.00','AUD',$3)`, [A, stmtA, payA.rows[0].id]));
  } catch (e) { payDup = e.code === '23505' || /duplicate key/.test(e.message); }
  check('spec 22: ONE payslip cannot evidence TWO fund contributions', payDup);

  // ------------------------------------------------------------- 6. apply
  console.log('\n6. APPLY (spec 105-110)');

  async function makeProposal(uid, statementId, targetId, fields) {
    const p = await db.query(
      `insert into fhip_import_proposals(user_id, target_domain, source_kind,
         source_retirement_statement_id, currency_code, target_entity_id,
         recommended_apply_mode, status)
       values ($1,'retirement','retirement_statement',$2,'AUD',$3,'update_existing','ready') returning id`,
      [uid, statementId, targetId]);
    const pid = p.rows[0].id;
    for (const f of fields) {
      await db.query(
        `insert into fhip_import_proposal_fields(user_id, proposal_id, field_name, value_kind,
           proposed_value, existing_value, is_recommended, requires_confirmation, reason_code)
         values ($1,$2,$3,$4,$5,$6,true,false,'test')`,
        [uid, pid, f.name, f.kind, f.proposed, f.existing]);
    }
    return pid;
  }

  // Evidence must be approved first.
  await asRole(db, 'service_role', A, () =>
    db.query(`update fdh_retirement_statements set approval_status='approved', approved_at=now(),
              approved_by=$2, extraction_status='extracted' where id=$1`, [stmtA, A]));

  const p1 = await makeProposal(A, stmtA, accA, [
    { name: 'current_balance', kind: 'money', proposed: '225000.00', existing: '220000.00' },
  ]);

  const applied = await asRole(db, 'authenticated', A, () =>
    db.query(`select fdh12_apply_retirement_proposal($1,'update_existing',null) as r`, [p1]));
  const r1 = applied.rows[0].r;
  check('a legitimate apply succeeds', r1.ok === true && r1.outcome === 'applied', JSON.stringify(r1).slice(0, 90));

  const bal = await db.query(`select current_balance, source_type from retirement_accounts where id=$1`, [accA]);
  check('canonical balance was updated to the statement closing balance',
    Number(bal.rows[0].current_balance) === 225000, `(${bal.rows[0].current_balance})`);
  check('provenance was stamped', bal.rows[0].source_type === 'retirement_statement_import');

  // spec 106 — duplicate apply.
  const again = await asRole(db, 'authenticated', A, () =>
    db.query(`select fdh12_apply_retirement_proposal($1,'update_existing',null) as r`, [p1]));
  check('spec 106: applying the SAME proposal twice returns ALREADY_APPLIED',
    again.rows[0].r.ok === false && again.rows[0].r.code === 'ALREADY_APPLIED');
  const balAfter = await db.query(`select current_balance from retirement_accounts where id=$1`, [accA]);
  check('spec 106: the second apply changed nothing', Number(balAfter.rows[0].current_balance) === 225000);

  // The application audit row is unique per proposal.
  const apps = await db.query(`select count(*)::int c from fhip_import_applications where proposal_id=$1`, [p1]);
  check('exactly ONE application row exists for the proposal', apps.rows[0].c === 1);

  // spec 108 — stale proposal.
  const p2 = await makeProposal(A, stmtA, accA, [
    { name: 'current_balance', kind: 'money', proposed: '300000.00', existing: '225000.00' },
  ]);
  // The user edits the balance themselves after the proposal was prepared.
  await db.query(`update retirement_accounts set current_balance=230000.00 where id=$1`, [accA]);
  const stale = await asRole(db, 'authenticated', A, () =>
    db.query(`select fdh12_apply_retirement_proposal($1,'update_existing',null) as r`, [p2]));
  check('spec 108: a STALE proposal is refused',
    stale.rows[0].r.ok === false && stale.rows[0].r.code === 'STALE_PROPOSAL',
    JSON.stringify(stale.rows[0].r).slice(0, 100));
  const balStale = await db.query(`select current_balance from retirement_accounts where id=$1`, [accA]);
  check('spec 108: the user\'s newer value was NOT overwritten',
    Number(balStale.rows[0].current_balance) === 230000);

  // spec 104 — a forged proposal naming a forbidden field.
  const p3 = await makeProposal(A, stmtA, accA, [
    { name: 'current_balance', kind: 'money', proposed: '240000.00', existing: '230000.00' },
    { name: 'target_retirement_age', kind: 'int', proposed: '50', existing: '67' },
  ]);
  const forbidden = await asRole(db, 'authenticated', A, () =>
    db.query(`select fdh12_apply_retirement_proposal($1,'apply_selected_fields',
              array['current_balance','target_retirement_age']) as r`, [p3]));
  check('spec 61/113: target_retirement_age is refused as FORBIDDEN_FIELD',
    forbidden.rows[0].r.ok === false && forbidden.rows[0].r.code === 'FORBIDDEN_FIELD',
    JSON.stringify(forbidden.rows[0].r).slice(0, 110));

  const ages = await db.query(`select target_retirement_age from retirement_members where user_id=$1`, [A]);
  check('spec 113: the member\'s target retirement age is UNCHANGED', ages.rows[0].target_retirement_age === 67);

  // spec 109 — selected apply leaves unselected fields alone.
  await db.query(`update retirement_accounts set employer_contribution=null where id=$1`, [accA]);
  const p4 = await makeProposal(A, stmtA, accA, [
    { name: 'current_balance', kind: 'money', proposed: '250000.00', existing: '230000.00' },
    { name: 'employer_contribution', kind: 'money', proposed: '800.00', existing: null },
  ]);
  const selective = await asRole(db, 'authenticated', A, () =>
    db.query(`select fdh12_apply_retirement_proposal($1,'apply_selected_fields',array['current_balance']) as r`, [p4]));
  check('spec 109: a selective apply succeeds', selective.rows[0].r.ok === true);
  const sel = await db.query(`select current_balance, employer_contribution from retirement_accounts where id=$1`, [accA]);
  check('spec 109: the SELECTED field was applied', Number(sel.rows[0].current_balance) === 250000);
  check('spec 109: the UNSELECTED field was left alone', sel.rows[0].employer_contribution === null);

  // spec 110 — KEEP EXISTING writes nothing.
  const p5 = await makeProposal(A, stmtA, accA, [
    { name: 'current_balance', kind: 'money', proposed: '999999.00', existing: '250000.00' },
  ]);
  const keep = await asRole(db, 'authenticated', A, () =>
    db.query(`select fdh12_apply_retirement_proposal($1,'keep_existing',null) as r`, [p5]));
  check('spec 110: KEEP EXISTING succeeds', keep.rows[0].r.ok === true && keep.rows[0].r.outcome === 'kept_existing');
  const kept = await db.query(`select current_balance from retirement_accounts where id=$1`, [accA]);
  check('spec 110: canonical retirement is UNCHANGED', Number(kept.rows[0].current_balance) === 250000);

  // spec 56 — unapproved evidence cannot be applied.
  const stmtUnapproved = await seedStatement(db, A);
  await asRole(db, 'service_role', A, () =>
    db.query(`update fdh_retirement_statements set canonical_account_id=$2 where id=$1`, [stmtUnapproved, accA]));
  const p6 = await makeProposal(A, stmtUnapproved, accA, [
    { name: 'current_balance', kind: 'money', proposed: '260000.00', existing: '250000.00' },
  ]);
  const unapproved = await asRole(db, 'authenticated', A, () =>
    db.query(`select fdh12_apply_retirement_proposal($1,'update_existing',null) as r`, [p6]));
  check('spec 56: UNAPPROVED evidence cannot be applied',
    unapproved.rows[0].r.ok === false && unapproved.rows[0].r.code === 'EVIDENCE_NOT_APPROVED');

  // spec 10/72 — an SMSF target is refused.
  // Migration 0084's `retirement_accounts_smsf_au_gate()` refuses to create an
  // SMSF row unless the user's home jurisdiction is AU — so the fixture needs
  // a profile. (That the gate fired while building this fixture is itself
  // live evidence the AU gate works.)
  await db.query(
    `insert into user_profiles(user_id, country_of_residence) values ($1,'AU')
     on conflict (user_id) do update set country_of_residence='AU'`, [A]);
  const smsfAcc = await db.query(
    `insert into retirement_accounts(user_id, account_name, account_type, current_balance,
       currency_code, country_code, owner, master_item_key, is_active)
     values ($1,'Family SMSF','super',500000.00,'AUD','AU','smsf','smsf',true) returning id`, [A]);
  const p7 = await makeProposal(A, stmtA, smsfAcc.rows[0].id, [
    { name: 'current_balance', kind: 'money', proposed: '600000.00', existing: '500000.00' },
  ]);
  const smsfRefusal = await asRole(db, 'authenticated', A, () =>
    db.query(`select fdh12_apply_retirement_proposal($1,'update_existing',null) as r`, [p7]));
  check('spec 10/72: an SMSF target is refused SMSF_ACCOUNT_NOT_IMPORTABLE',
    smsfRefusal.rows[0].r.ok === false && smsfRefusal.rows[0].r.code === 'SMSF_ACCOUNT_NOT_IMPORTABLE',
    JSON.stringify(smsfRefusal.rows[0].r).slice(0, 110));
  const smsfBal = await db.query(`select current_balance from retirement_accounts where id=$1`, [smsfAcc.rows[0].id]);
  check('spec 72: the SMSF balance is UNCHANGED', Number(smsfBal.rows[0].current_balance) === 500000);

  // spec 97 — cross-tenant apply.
  const pCross = await makeProposal(A, stmtA, accA, [
    { name: 'current_balance', kind: 'money', proposed: '777777.00', existing: '250000.00' },
  ]);
  const crossApply = await asRole(db, 'authenticated', B, () =>
    db.query(`select fdh12_apply_retirement_proposal($1,'update_existing',null) as r`, [pCross]));
  check('spec 97: Tenant B cannot apply Tenant A\'s proposal',
    crossApply.rows[0].r.ok === false && crossApply.rows[0].r.code === 'PROPOSAL_NOT_FOUND');
  const balCross = await db.query(`select current_balance from retirement_accounts where id=$1`, [accA]);
  check('spec 97: Tenant A\'s balance is UNCHANGED by Tenant B', Number(balCross.rows[0].current_balance) === 250000);

  // spec 107 — concurrency: two applies of one proposal, exactly one wins.
  const pRace = await makeProposal(A, stmtA, accA, [
    { name: 'current_balance', kind: 'money', proposed: '251000.00', existing: '250000.00' },
  ]);
  const [ra, rb] = await Promise.all([
    asRole(db, 'authenticated', A, () =>
      db.query(`select fdh12_apply_retirement_proposal($1,'update_existing',null) as r`, [pRace])),
    asRole(db, 'authenticated', A, () =>
      db.query(`select fdh12_apply_retirement_proposal($1,'update_existing',null) as r`, [pRace])),
  ]);
  const wins = [ra.rows[0].r, rb.rows[0].r].filter((x) => x.ok === true).length;
  check('spec 107: two concurrent applies produce EXACTLY ONE canonical application', wins === 1,
    `(ok count = ${wins})`);
  const raceApps = await db.query(`select count(*)::int c from fhip_import_applications where proposal_id=$1`, [pRace]);
  check('spec 107: exactly ONE application row was recorded', raceApps.rows[0].c === 1);

  // spec 105 — atomicity: a failing apply leaves nothing behind.
  const beforeApps = await db.query(`select count(*)::int c from fhip_import_applications`);
  const pBad = await makeProposal(A, stmtA, accA, [
    { name: 'current_balance', kind: 'money', proposed: 'not-a-number', existing: '251000.00' },
  ]);
  let threw = false;
  try {
    await asRole(db, 'authenticated', A, () =>
      db.query(`select fdh12_apply_retirement_proposal($1,'update_existing',null) as r`, [pBad]));
  } catch { threw = true; }
  const afterApps = await db.query(`select count(*)::int c from fhip_import_applications`);
  const pStatus = await db.query(`select status from fhip_import_proposals where id=$1`, [pBad]);
  check('spec 105: a failing apply is ATOMIC — no application row survives',
    afterApps.rows[0].c === beforeApps.rows[0].c, `(threw=${threw})`);
  check('spec 105: a failing apply does not strand the proposal as applied',
    pStatus.rows[0].status === 'ready');
  const balAtomic = await db.query(`select current_balance from retirement_accounts where id=$1`, [accA]);
  check('spec 105: the canonical balance was not partially written',
    Number(balAtomic.rows[0].current_balance) === 251000);

  // ------------------------------------------------- 7. harness self-check
  console.log('\n7. HARNESS SELF-CHECK');
  const weakDb = await buildDb((filename, sql) => {
    if (filename.startsWith('0112')) {
      const before = sql;
      const after = sql.replace(
        /create trigger trg_fdh_retirement_statements_authoritative_write[\s\S]*?fdh12_retirement_statements_assert_authoritative_write\(\);/,
        '-- trigger deliberately omitted for harness self-check');
      if (after === before) {
        throw new Error('harness self-check regex did not match — fix the pattern before trusting check 3');
      }
      return after;
    }
    return sql;
  });
  await weakDb.exec(`insert into auth.users(id,email) values ('${A}','a@t.test');`);
  const weakStmt = await seedStatement(weakDb, A);
  let forgedSucceeded = false;
  try {
    await asRole(weakDb, 'authenticated', A, () =>
      weakDb.query(`update fdh_retirement_statements set approval_status='approved' where id=$1`, [weakStmt]));
    const r = await weakDb.query(`select approval_status from fdh_retirement_statements where id=$1`, [weakStmt]);
    forgedSucceeded = r.rows[0].approval_status === 'approved';
  } catch { forgedSucceeded = false; }
  check('harness self-check: with the guard trigger REMOVED, forgery SUCCEEDS (so section 3 is not vacuous)',
    forgedSucceeded);

  // ------------------------------------------------------------------ result
  console.log(`\n${'='.repeat(60)}`);
  console.log(`FDH-12 PGlite certification: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
}

main();
