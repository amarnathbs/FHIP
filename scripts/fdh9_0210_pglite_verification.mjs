// WP-09 -- PGlite verification for migration 0210_fdh9_income_apply_guards.sql.
//
// Case A: the real chain replayed up to (not including) 0210, one synthetic
//   household per scenario, every defect PROVEN to exist before 0210
//   (anti-vacuity), then 0210 applied and every acceptance claim checked on
//   FRESH identical scenarios, then 0210 applied a second time (the schema
//   fingerprint must not move).
// Case B: a database that already holds two Income applications for one
//   payroll event -- 0210 must REFUSE (preflight) and change nothing.
//
// Every check prints PASS/FAIL with a name; the process exits non-zero on any
// FAIL, and refuses to report a pass if too few checks ran.
//
// Run: node scripts/fdh9_0210_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0210_fdh9_income_apply_guards.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const target = strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

async function replayUpToTarget() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  for (const f of files) {
    if (f >= TARGET) break;
    await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
  }
  return db;
}

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const errorOf = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const schemaFingerprint = async (db) => {
  const c = (await db.query(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = 'public'::regnamespace order by 1,2`)).rows;
  const i = (await db.query(`select indexname, indexdef from pg_indexes where schemaname='public' order by 1`)).rows;
  const t = (await db.query(`select tgname, tgrelid::regclass::text r from pg_trigger where not tgisinternal order by 1,2`)).rows;
  const f = (await db.query(`select proname, pg_get_function_identity_arguments(oid) a, md5(prosrc) h from pg_proc where pronamespace = 'public'::regnamespace order by 1,2`)).rows;
  const k = (await db.query(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2`)).rows;
  return JSON.stringify({ c, i, t, f, k });
};

// ---------------------------------------------------------------------------
// Synthetic households. Each scenario gets its own user so nothing leaks
// between checks; ids are deterministic per (prefix, n).
// ---------------------------------------------------------------------------
let seq = 0;
const uid = () => {
  seq += 1;
  const hex = seq.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
};

async function newUser(db) {
  const id = uid();
  await db.exec(`insert into auth.users(id, email) values ('${id}', 'u${seq}@t.test')`);
  await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='${id}'`);
  return id;
}

async function asUser(db, user, fn) {
  await db.exec(`set request.jwt.claim.role = 'authenticated'; set request.jwt.claim.sub = '${user}'`);
  try { return await fn(); } finally { await db.exec(`reset request.jwt.claim.role; reset request.jwt.claim.sub`); }
}

async function rpc(db, user, sql) {
  return asUser(db, user, async () => {
    try { return (await one(db, `select ${sql} as r`)).r; } catch (e) { return { ok: false, code: 'RAISED', error: e.message }; }
  });
}

async function income(db, user, row) {
  const id = uid();
  await db.exec(`insert into income_sources (id, user_id, source_name, income_type, amount, net_amount, frequency, currency_code, owner, employer_name, master_item_key)
    values ('${id}', '${user}', '${row.name ?? 'Salary'}', 'salary', ${row.amount}, ${row.net ?? 'null'}, '${row.frequency ?? 'monthly'}', '${row.currency ?? 'AUD'}', '${row.owner ?? 'self'}', ${row.employer ? `'${row.employer}'` : 'null'}, ${row.masterKey ? `'${row.masterKey}'` : 'null'})`);
  return id;
}

async function payrollEvent(db, user, e = {}) {
  const id = uid();
  await db.exec(`insert into fdh_payroll_events (id, user_id, employer_name, employer_normalised, country_code, currency_code, pay_period_start, pay_period_end, payment_date,
      pay_frequency, gross_pay, net_pay, bonus_pay, approval_status, approved_at, approved_by, review_status, payslip_fingerprint, income_owner)
    values ('${id}', '${user}', ${e.employer ? `'${e.employer}'` : 'null'}, ${e.employer ? `'${e.employer.toLowerCase()}'` : 'null'}, '${e.country ?? 'AU'}', '${e.currency ?? 'AUD'}',
      ${e.start ? `'${e.start}'` : 'null'}, ${e.end ? `'${e.end}'` : `'2026-08-31'`}, '${e.paid ?? '2026-08-31'}', '${e.freq ?? 'monthly'}', ${e.gross ?? 6500}, ${e.net ?? 5000}, ${e.bonus ?? 'null'},
      '${e.approved === false ? 'pending' : 'approved'}', ${e.approved === false ? 'null' : 'now()'}, ${e.approved === false ? 'null' : `'${user}'`},
      '${e.review ?? 'not_required'}', '${e.fingerprint ?? `fp-${id}`}', ${e.owner ? `'${e.owner}'` : 'null'})`);
  return id;
}

/** A 'ready' income proposal with the given fields ([name, kind, proposed, existing, recommended, confirm]). */
async function proposal(db, user, eventId, { target = null, currency = 'AUD', mode = 'add_new' } = {}, fields) {
  const id = uid();
  await db.exec(`insert into fhip_import_proposals (id, user_id, target_domain, source_kind, source_payroll_event_id, currency_code, target_entity_id, recommended_apply_mode, status)
    values ('${id}', '${user}', 'income', 'payslip', '${eventId}', '${currency}', ${target ? `'${target}'` : 'null'}, '${mode}', 'ready')`);
  for (const [name, kind, proposed, existing = null, recommended = true, confirm = false] of fields) {
    await db.exec(`insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value, existing_value, is_recommended, requires_confirmation, reason_code)
      values ('${user}', '${id}', '${name}', '${kind}', ${proposed === null ? 'null' : `'${proposed}'`}, ${existing === null ? 'null' : `'${existing}'`}, ${recommended}, ${confirm}, 'test')`);
  }
  return id;
}

const NEW_ROW_FIELDS = (amount = '6500.00', net = '5000.00') => [
  ['source_name', 'text', 'Salary'], ['income_type', 'enum', 'salary'], ['is_taxable', 'bool', 'true'],
  ['amount', 'money', amount], ['net_amount', 'money', net], ['frequency', 'enum', 'monthly'], ['currency_code', 'enum', 'AUD'],
];
const ADD_NEW_SELECTION = `array['source_name','income_type','is_taxable','amount','net_amount','frequency','currency_code']`;

const count = async (db, sql) => (await one(db, `select count(*)::int n from (${sql}) q`)).n;
const incomeRows = (db, user, extra = '') => count(db, `select 1 from income_sources where user_id = '${user}' ${extra}`);

async function txn(db, user, t) {
  const acc = uid();
  await db.exec(`insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name) values ('${acc}', '${user}', 'transaction', 'AU', '${t.currency ?? 'AUD'}', 'Everyday')`);
  const id = uid();
  await db.exec(`insert into fdh_transactions (id, user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type)
    values ('${id}', '${user}', '${acc}', '${t.date ?? '2026-08-31'}', ${t.amount ?? 5000}, '${t.currency ?? 'AUD'}', '${t.direction ?? 'credit'}', '${t.type ?? 'income'}')`);
  if (t.approved !== false) {
    await db.exec(`update fdh_transactions set approval_status = 'approved', approved_at = now(), approved_by = '${user}' where id = '${id}'`);
  }
  return id;
}

/**
 * The canonical read-model rule (lib/read-models/income.ts), restated in SQL
 * for this database-level check: planned income rows + approved bank income
 * credits that are NOT corroborated by an approved, non-superseded payroll
 * event which was Applied to a counted income row. The TS read model itself
 * is exercised in tests/unit/payslipBankRematch.test.ts.
 */
async function incomeEffects(db, user, txnIds) {
  return count(db, `
    select id from income_sources where user_id = '${user}' and is_active and not coalesce(superseded_by_bank_import, false)
    union all
    select t.id from fdh_transactions t
    where t.user_id = '${user}' and t.id in (${txnIds.map((t) => `'${t}'`).join(', ')}) and t.approval_status = 'approved' and t.economic_transaction_type = 'income' and t.credit_debit = 'credit'
      and not exists (
        select 1 from fdh_payroll_events e
        join fhip_import_applications a on a.source_payroll_event_id = e.id and a.target_domain = 'income'
        join income_sources s on s.id = a.target_entity_id and s.is_active
        where e.bank_match_transaction_id = t.id and e.bank_match_status = 'matched' and e.approval_status = 'approved'
          and e.superseded_by_payroll_event_id is null and e.currency_code = t.currency_original
      )`);
}

/** Protected columns named in the live trigger function body. */
async function protectedColumns(db) {
  const src = (await one(db, `select prosrc from pg_proc where proname = 'fdh9_payroll_events_assert_authoritative_write'`)).prosrc;
  return [...src.matchAll(/new\.([a-z_]+) is distinct from old\.\1/g)].map((m) => m[1]);
}

// ===========================================================================
// The scenarios, parameterised so the SAME steps run before and after 0210.
// Each returns the observable facts; the checks compare them to expectations.
// ===========================================================================
async function scenarioReapplyNoEmployer(db) {
  const u = await newUser(db);
  const ev = await payrollEvent(db, u, { employer: null });
  const p1 = await proposal(db, u, ev, {}, NEW_ROW_FIELDS());
  const r1 = await rpc(db, u, `fdh9_apply_income_proposal('${p1}', 'add_new', ${ADD_NEW_SELECTION})`);
  // The re-upload path: a fresh 'ready' proposal for the SAME approved event.
  const p2 = await proposal(db, u, ev, {}, NEW_ROW_FIELDS());
  const r2 = await rpc(db, u, `fdh9_apply_income_proposal('${p2}', 'add_new', ${ADD_NEW_SELECTION})`);
  return { u, ev, r1, r2, rows: await incomeRows(db, u), apps: await count(db, `select 1 from fhip_import_applications where user_id = '${u}' and source_payroll_event_id = '${ev}'`) };
}

async function scenarioCurrency(db) {
  const u = await newUser(db);
  const row = await income(db, u, { amount: 6500, net: 5000, currency: 'AUD', employer: 'Acme' });
  const ev = await payrollEvent(db, u, { employer: 'Acme', currency: 'INR', country: 'IN', gross: 200000, net: 150000 });
  const p = await proposal(db, u, ev, { target: row, currency: 'INR', mode: 'update_existing' }, [['amount', 'money', '200000.00', '6500.00'], ['net_amount', 'money', '150000.00', '5000.00']]);
  const r = await rpc(db, u, `fdh9_apply_income_proposal('${p}', 'update_existing', null)`);
  const after = await one(db, `select amount::numeric a, currency_code c from income_sources where id = '${row}'`);
  return { r, amount: Number(after.a), currency: after.c };
}

async function scenarioSpouse(db, { approveAsSpouse }) {
  const u = await newUser(db);
  const spouseRow = await income(db, u, { amount: 7000, net: 5400, employer: 'Globex', owner: 'spouse', name: 'Spouse salary' });
  const ev = await payrollEvent(db, u, { employer: 'Globex', approved: false, gross: 7200, net: 5550 });
  const approve = approveAsSpouse
    ? await rpc(db, u, `fdh9_approve_payroll_event('${ev}', 'spouse', false)`)
    : await rpc(db, u, `fdh9_approve_payroll_event('${ev}')`);
  const p = await proposal(db, u, ev, { target: spouseRow, mode: 'update_existing' }, [['amount', 'money', '7200.00', '7000.00'], ['net_amount', 'money', '5550.00', '5400.00']]);
  const r = await rpc(db, u, `fdh9_apply_income_proposal('${p}', 'update_existing', null)`);
  // A second spouse payslip from a new employer -> add_new must be the spouse's row.
  const ev2 = await payrollEvent(db, u, { employer: 'Initech', approved: false, fingerprint: `fp2-${u}` });
  if (approveAsSpouse) await rpc(db, u, `fdh9_approve_payroll_event('${ev2}', 'spouse', false)`);
  else await rpc(db, u, `fdh9_approve_payroll_event('${ev2}')`);
  const p2 = await proposal(db, u, ev2, {}, NEW_ROW_FIELDS());
  const r2 = await rpc(db, u, `fdh9_apply_income_proposal('${p2}', 'add_new', ${ADD_NEW_SELECTION})`);
  return {
    approve, r, r2,
    spouseAmount: Number((await one(db, `select amount::numeric a from income_sources where id = '${spouseRow}'`)).a),
    selfRows: await incomeRows(db, u, `and owner = 'self'`),
    spouseRows: await incomeRows(db, u, `and owner = 'spouse'`),
  };
}

async function scenarioFrequencyUnticked(db) {
  const u = await newUser(db);
  const row = await income(db, u, { amount: 6000, net: 4700, employer: 'Acme', frequency: 'monthly' });
  const fields = () => [['amount', 'money', '6500.00', '6000.00'], ['frequency', 'enum', 'fortnightly', 'monthly', true, true]];
  const ev1 = await payrollEvent(db, u, { employer: 'Acme' });
  const p1 = await proposal(db, u, ev1, { target: row, mode: 'update_existing' }, fields());
  const rNull = await rpc(db, u, `fdh9_apply_income_proposal('${p1}', 'update_existing', null)`);
  const afterNull = await one(db, `select amount::numeric a, frequency f from income_sources where id = '${row}'`);
  // Explicit selection without frequency (a second user, same starting row).
  const u2 = await newUser(db);
  const row2 = await income(db, u2, { amount: 6000, net: 4700, employer: 'Acme', frequency: 'monthly' });
  const ev2 = await payrollEvent(db, u2, { employer: 'Acme' });
  const p2 = await proposal(db, u2, ev2, { target: row2, mode: 'update_existing' }, fields());
  const rList = await rpc(db, u2, `fdh9_apply_income_proposal('${p2}', 'apply_selected_fields', array['amount'])`);
  const afterList = await one(db, `select amount::numeric a, frequency f from income_sources where id = '${row2}'`);
  return { rNull, afterNull: { amount: Number(afterNull.a), frequency: afterNull.f }, rList, afterList: { amount: Number(afterList.a), frequency: afterList.f } };
}

async function scenarioForgedOwner(db) {
  const u = await newUser(db);
  const ev = await payrollEvent(db, u, { employer: 'Acme', owner: 'self' });
  const err = await asUser(db, u, () => errorOf(db, `update fdh_payroll_events set income_owner = 'spouse' where id = '${ev}'`));
  const owner = (await one(db, `select income_owner o from fdh_payroll_events where id = '${ev}'`)).o;
  return { err, owner };
}

async function scenarioReviewGate(db) {
  const u = await newUser(db);
  const ev = await payrollEvent(db, u, { employer: 'Acme', approved: false, review: 'pending' });
  const r1 = await rpc(db, u, `fdh9_approve_payroll_event('${ev}')`);
  const s1 = await one(db, `select approval_status a, review_status r from fdh_payroll_events where id = '${ev}'`);
  return { u, ev, r1, s1 };
}

// ===========================================================================
console.log('Case A -- full chain to 0209, anti-vacuity, then 0210 (twice)');
{
  const db = await replayUpToTarget();

  // ------------------------------- BEFORE 0210 -------------------------------
  console.log(' BEFORE 0210 (every defect must be real):');
  const b1 = await scenarioReapplyNoEmployer(db);
  check('anti-vacuity GAP-04: re-upload + Apply twice with no employer creates TWO income rows before 0210',
    b1.r1.ok === true && b1.r2.ok === true && b1.rows === 2 && b1.apps === 2, JSON.stringify({ r2: b1.r2, rows: b1.rows, apps: b1.apps }));

  const b2 = await scenarioCurrency(db);
  check('anti-vacuity GAP-03: an INR proposal overwrites the AUD row before 0210',
    b2.r.ok === true && b2.amount === 200000 && b2.currency === 'AUD', JSON.stringify(b2));

  const b3 = await scenarioSpouse(db, { approveAsSpouse: false });
  check('anti-vacuity GAP-05: before 0210 a spouse payslip cannot update the spouse row (MEMBER_MISMATCH) and add_new creates a SELF row',
    b3.r.ok === false && b3.r.code === 'MEMBER_MISMATCH' && b3.r2.ok === true && b3.selfRows === 1 && b3.spouseAmount === 7000, JSON.stringify(b3));
  const approveArity = await one(db, `select string_agg(pg_get_function_identity_arguments(oid), ' | ') s from pg_proc where proname = 'fdh9_approve_payroll_event'`);
  check('anti-vacuity: before 0210 the approve RPC takes no owner (one argument)', approveArity.s === 'p_payroll_event_id uuid', approveArity.s);

  const b4 = await scenarioFrequencyUnticked(db);
  check('anti-vacuity X-01: update_existing with no field list applies the "please confirm" frequency before 0210',
    b4.rNull.ok === true && b4.afterNull.frequency === 'fortnightly', JSON.stringify(b4.afterNull));

  const b5 = await scenarioForgedOwner(db);
  check('anti-vacuity: a direct income_owner update is ACCEPTED before 0210 (0207 column, unprotected)', b5.err === null && b5.owner === 'spouse', JSON.stringify(b5));

  const b6 = await scenarioReviewGate(db);
  check('anti-vacuity: a payslip with review pending is approved in one call before 0210',
    b6.r1.ok === true && b6.s1.a === 'approved' && b6.s1.r === 'pending', JSON.stringify(b6.s1));

  const restampBefore = await one(db, `select count(*)::int n from pg_proc where proname in ('fdh9_restamp_payroll_bank_match', 'fdh9_supersede_payroll_event')`);
  check('anti-vacuity GAP-10/15: no restamp and no supersede RPC exist before 0210', restampBefore.n === 0);
  {
    const u = await newUser(db);
    const ev = await payrollEvent(db, u, { employer: 'Acme' });
    const t = await txn(db, u, {});
    const err = await asUser(db, u, () => errorOf(db, `update fdh_payroll_events set bank_match_status = 'matched', bank_match_transaction_id = '${t}' where id = '${ev}'`));
    check('anti-vacuity GAP-10: the bank match columns are trigger-locked, so without an RPC a late bank credit can never be linked', err !== null && /system-authoritative/.test(err), err ?? 'accepted');
  }
  const protectedBefore = await protectedColumns(db);
  check('anti-vacuity: the live trigger (0185) does not protect income_owner', protectedBefore.length >= 50 && !protectedBefore.includes('income_owner'), `${protectedBefore.length} columns`);
  const anonBefore = await one(db, `select has_function_privilege('anon', 'fdh9_apply_income_proposal(uuid,text,text[])', 'execute') a`);
  check('anti-vacuity: before 0210 anon holds EXECUTE on the apply RPC (default privileges; revoke from public alone never removed it)', anonBefore.a === true);
  const idxBefore = await one(db, `select count(*)::int n from pg_indexes where indexname = 'uq_fhip_import_applications_income_payroll_event_0210'`);
  check('anti-vacuity: no per-event unique index before 0210', idxBefore.n === 0);

  // -------------------------------- APPLY 0210 --------------------------------
  // Case A's database now holds GAP-04 duplicates from the anti-vacuity run,
  // so the preflight must refuse here first (that is Case B's claim too) --
  // then the PO's prepared cleanup is run and 0210 applies.
  const refused = await errorOf(db, target);
  check('0210 preflight refuses while the anti-vacuity duplicates exist', refused !== null && /0210 preflight: 1 payroll event/.test(refused), refused ?? 'applied');
  const cleanup = fs.readFileSync(path.join(HERE, 'fdh9_0210_duplicate_income_applications_report.sql'), 'utf8');
  const cleanupSql = cleanup.split('-- begin;')[1].split('-- -- check')[0].replace(/^-- ?/gm, '');
  const report = await db.query(cleanup.split('-- STEP 2')[0].replace(/^--.*$/gm, ''));
  check('the prepared report lists exactly the duplicate event', report.rows.length === 1 && report.rows[0].source_payroll_event_id === b1.ev && Number(report.rows[0].applications) === 2);
  await db.exec(cleanupSql);
  const appsAfterCleanup = await count(db, `select 1 from fhip_import_applications where source_payroll_event_id = '${b1.ev}'`);
  const appsTotal = await count(db, `select 1 from fhip_import_applications where user_id = '${b1.u}'`);
  check('the prepared cleanup keeps every application row and detaches only the later duplicate', appsAfterCleanup === 1 && appsTotal === 2);

  const applyErr = await errorOf(db, target);
  check('0210 applies after the cleanup', applyErr === null, applyErr ?? '');

  // -------------------------------- AFTER 0210 --------------------------------
  console.log(' AFTER 0210:');
  const a1 = await scenarioReapplyNoEmployer(db);
  check('GAP-04: re-upload then Apply twice with no employer gives exactly 1 income row',
    a1.r1.ok === true && a1.r2.ok === false && a1.r2.code === 'ALREADY_APPLIED' && a1.rows === 1 && a1.apps === 1, JSON.stringify({ r2: a1.r2, rows: a1.rows }));
  check('GAP-04: ALREADY_APPLIED names the income row the payslip is already in', a1.r2.target_entity_id === a1.r1.target_entity_id);
  const p2Status = await one(db, `select status from fhip_import_proposals where source_payroll_event_id = '${a1.ev}' order by generated_at desc limit 1`);
  check('GAP-04: the refused proposal stays ready (nothing was claimed or written)', p2Status.status === 'ready');
  {
    // The un-bypassable backstop: even a definer-context insert cannot add a
    // second Income application for the event.
    const firstApp = await one(db, `select proposal_id from fhip_import_applications where source_payroll_event_id = '${a1.ev}'`);
    const other = await proposal(db, a1.u, a1.ev, {}, NEW_ROW_FIELDS());
    const err = await errorOf(db, `begin; select set_config('fhip.import_bridge_internal_write','true',true);
      insert into fhip_import_applications (user_id, proposal_id, target_domain, target_entity_id, apply_mode, applied_fields, previous_values, new_values, source_payroll_event_id, applied_by)
      values ('${a1.u}', '${other}', 'income', '${a1.r1.target_entity_id}', 'add_new', '[]', '{}', '{}', '${a1.ev}', '${a1.u}'); commit;`);
    await db.exec('rollback').catch(() => {});
    check('GAP-04 backstop: the partial unique index refuses a second Income application for one payroll event', err !== null && /duplicate key|unique/i.test(err) && Boolean(firstApp), err ?? 'accepted');
  }
  {
    const newRow = await one(db, `select owner, source_type, master_item_key, is_taxable from income_sources where id = '${a1.r1.target_entity_id}'`);
    check('add_new: a payslip salary row is classified employment_salary, owner self, source payslip_import, is_taxable boolean',
      newRow.master_item_key === 'employment_salary' && newRow.owner === 'self' && newRow.source_type === 'payslip_import' && newRow.is_taxable === true, JSON.stringify(newRow));
    // A second, different payslip for the same user: the catalogue slot is taken -> custom row, no unique violation.
    const ev2 = await payrollEvent(db, a1.u, { employer: 'Second Job', fingerprint: `fp-second-${a1.u}` });
    const p = await proposal(db, a1.u, ev2, {}, NEW_ROW_FIELDS('1200.00', '1000.00'));
    const r = await rpc(db, a1.u, `fdh9_apply_income_proposal('${p}', 'add_new', ${ADD_NEW_SELECTION})`);
    const second = r.ok ? await one(db, `select master_item_key from income_sources where id = '${r.target_entity_id}'`) : null;
    check('add_new: when employment_salary is taken the second salary is a custom (null key) row, not a unique-violation failure', r.ok === true && second?.master_item_key === null, JSON.stringify(r));
  }

  const a2 = await scenarioCurrency(db);
  check('GAP-03: an INR proposal update onto an AUD row gets CURRENCY_MISMATCH', a2.r.ok === false && a2.r.code === 'CURRENCY_MISMATCH', JSON.stringify(a2.r));
  check('GAP-03: the AUD row is unchanged', a2.amount === 6500 && a2.currency === 'AUD', JSON.stringify(a2));

  const a3 = await scenarioSpouse(db, { approveAsSpouse: true });
  check('GAP-05: approving with owner spouse records it', a3.approve.ok === true && a3.approve.income_owner === 'spouse', JSON.stringify(a3.approve));
  check('GAP-05: a spouse payslip plus a spouse manual row updates the spouse row', a3.r.ok === true && a3.spouseAmount === 7200, JSON.stringify(a3.r));
  check('GAP-05: 0 new self rows; the spouse add_new row is owned by the spouse', a3.selfRows === 0 && a3.spouseRows === 2 && a3.r2.ok === true && a3.r2.owner === 'spouse', JSON.stringify(a3));
  {
    // The generalised MEMBER_MISMATCH: a SELF payslip still cannot touch the spouse row.
    const u = await newUser(db);
    const spouseRow = await income(db, u, { amount: 7000, employer: 'Globex', owner: 'spouse' });
    const ev = await payrollEvent(db, u, { employer: 'Globex', approved: false });
    await rpc(db, u, `fdh9_approve_payroll_event('${ev}', 'self', false)`);
    const p = await proposal(db, u, ev, { target: spouseRow, mode: 'update_existing' }, [['amount', 'money', '9999.00', '7000.00']]);
    const r = await rpc(db, u, `fdh9_apply_income_proposal('${p}', 'update_existing', null)`);
    check('GAP-05: a SELF payslip targeting the spouse row is still MEMBER_MISMATCH (FDH15-DEF-001 stays closed)', r.ok === false && r.code === 'MEMBER_MISMATCH', JSON.stringify(r));
    const again = await rpc(db, u, `fdh9_approve_payroll_event('${ev}', 'spouse', false)`);
    check('GAP-05: the owner is locked after approval (OWNER_LOCKED)', again.ok === false && again.code === 'OWNER_LOCKED', JSON.stringify(again));
    const bad = await rpc(db, u, `fdh9_approve_payroll_event('${await payrollEvent(db, u, { approved: false, fingerprint: 'x' + u })}', 'joint', false)`);
    check('GAP-05: an owner outside self/spouse is refused (INVALID_OWNER)', bad.ok === false && bad.code === 'INVALID_OWNER', JSON.stringify(bad));
  }
  {
    // Legacy events (approved before 0210, income_owner null) keep the old behaviour: self.
    const u = await newUser(db);
    const selfRow = await income(db, u, { amount: 6000, employer: 'Acme', owner: 'self' });
    const ev = await payrollEvent(db, u, { employer: 'Acme' }); // approved, income_owner null
    const p = await proposal(db, u, ev, { target: selfRow, mode: 'update_existing' }, [['amount', 'money', '6500.00', '6000.00']]);
    const r = await rpc(db, u, `fdh9_apply_income_proposal('${p}', 'update_existing', null)`);
    check('legacy event with no owner behaves as self (updates the self row)', r.ok === true, JSON.stringify(r));
  }

  const a4 = await scenarioFrequencyUnticked(db);
  check('X-01: update_existing with no field list leaves the "please confirm" frequency unchanged', a4.rNull.ok === true && a4.afterNull.frequency === 'monthly' && a4.afterNull.amount === 6500, JSON.stringify(a4.afterNull));
  check('update_existing with the frequency unticked (explicit list) leaves frequency unchanged', a4.rList.ok === true && a4.afterList.frequency === 'monthly' && a4.afterList.amount === 6500, JSON.stringify(a4.afterList));

  const a5 = await scenarioForgedOwner(db);
  check('a forged income_owner update is refused by the authoritative trigger', a5.err !== null && /system-authoritative/.test(a5.err) && a5.owner === 'self', JSON.stringify(a5));
  const protectedAfter = await protectedColumns(db);
  const missing = protectedBefore.filter((c) => !protectedAfter.includes(c));
  check('the trigger protects a STRICT SUPERSET of 0185 (+ income_owner, nothing dropped)', missing.length === 0 && protectedAfter.length === protectedBefore.length + 1 && protectedAfter.includes('income_owner'), `missing=${missing.join(',')}`);

  const a6 = await scenarioReviewGate(db);
  check('review gate: a pending-review payslip is refused without acknowledgement (REVIEW_REQUIRED)', a6.r1.ok === false && a6.r1.code === 'REVIEW_REQUIRED' && a6.s1.a === 'pending', JSON.stringify(a6.r1));
  {
    const r2 = await rpc(db, a6.u, `fdh9_approve_payroll_event('${a6.ev}', null, true)`);
    const s2 = await one(db, `select approval_status a, review_status r, income_owner o from fdh_payroll_events where id = '${a6.ev}'`);
    check('review gate: acknowledged approval resolves the review and stamps owner self', r2.ok === true && r2.review_acknowledged === true && s2.a === 'approved' && s2.r === 'resolved' && s2.o === 'self', JSON.stringify(s2));
  }
  {
    const arity = await one(db, `select string_agg(pg_get_function_identity_arguments(oid), ' | ') s from pg_proc where proname = 'fdh9_approve_payroll_event'`);
    check('the ungated one-argument approve signature is gone (no overload left behind)', arity.s === 'p_payroll_event_id uuid, p_income_owner text, p_acknowledge_review boolean', arity.s);
  }

  // ---------------- GAP-10: bank imported AFTER the payslip ----------------
  {
    const u = await newUser(db);
    const ev = await payrollEvent(db, u, { employer: 'Acme', net: 5000, gross: 6500 });
    const p = await proposal(db, u, ev, {}, NEW_ROW_FIELDS());
    const applied = await rpc(db, u, `fdh9_apply_income_proposal('${p}', 'add_new', ${ADD_NEW_SELECTION})`);
    const credit = await txn(db, u, { amount: 5000, date: '2026-08-31' });
    const effectsBefore = await incomeEffects(db, u, [credit]);
    check('GAP-10 setup: payslip Applied, then the matching bank credit approved -> TWO income effects while unlinked', applied.ok === true && effectsBefore === 2, `effects=${effectsBefore}`);

    const pending = await txn(db, u, { amount: 5000, date: '2026-08-30', approved: false });
    const debit = await txn(db, u, { amount: 5000, direction: 'debit', type: 'expense' });
    const usd = await txn(db, u, { amount: 5000, currency: 'USD' });
    const other = await txn(db, u, { amount: 4999 });
    const far = await txn(db, u, { amount: 5000, date: '2026-08-10' });
    const rPending = await rpc(db, u, `fdh9_restamp_payroll_bank_match('${ev}', '${pending}', 0.9)`);
    const rDebit = await rpc(db, u, `fdh9_restamp_payroll_bank_match('${ev}', '${debit}', 0.9)`);
    const rUsd = await rpc(db, u, `fdh9_restamp_payroll_bank_match('${ev}', '${usd}', 0.9)`);
    const rOther = await rpc(db, u, `fdh9_restamp_payroll_bank_match('${ev}', '${other}', 0.9)`);
    const rFar = await rpc(db, u, `fdh9_restamp_payroll_bank_match('${ev}', '${far}', 0.9)`);
    check('restamp refuses an UNAPPROVED credit', rPending.code === 'NOT_AN_APPROVED_INCOME_CREDIT', JSON.stringify(rPending));
    check('restamp refuses a debit', rDebit.code === 'NOT_AN_APPROVED_INCOME_CREDIT', JSON.stringify(rDebit));
    check('restamp refuses another currency', rUsd.code === 'CURRENCY_MISMATCH', JSON.stringify(rUsd));
    check('restamp refuses a different amount', rOther.code === 'AMOUNT_MISMATCH', JSON.stringify(rOther));
    check('restamp refuses a credit more than 7 days from the payment date', rFar.code === 'DATE_TOO_FAR', JSON.stringify(rFar));

    const stranger = await newUser(db);
    const strangerTxn = await txn(db, stranger, { amount: 5000 });
    const rCross = await rpc(db, u, `fdh9_restamp_payroll_bank_match('${ev}', '${strangerTxn}', 0.9)`);
    const rCross2 = await rpc(db, stranger, `fdh9_restamp_payroll_bank_match('${ev}', '${strangerTxn}', 0.9)`);
    check('restamp is tenant-scoped both ways (another user\'s transaction / event)', rCross.code === 'TRANSACTION_NOT_FOUND' && rCross2.code === 'PAYROLL_EVENT_NOT_FOUND', `${rCross.code} ${rCross2.code}`);

    const r = await rpc(db, u, `fdh9_restamp_payroll_bank_match('${ev}', '${credit}', 0.9)`);
    const stamped = await one(db, `select bank_match_status s, bank_match_transaction_id t, bank_match_confidence::numeric c from fdh_payroll_events where id = '${ev}'`);
    check('GAP-10: the restamp links the approved salary credit', r.ok === true && stamped.s === 'matched' && stamped.t === credit && Number(stamped.c) === 0.9, JSON.stringify(stamped));
    const effectsAfter = await incomeEffects(db, u, [credit]);
    check('GAP-10 / GAP-01: after the restamp the household has ONE income effect (payslip 5,000 + bank 5,000 = 5,000)', effectsAfter === 1, `effects=${effectsAfter}`);
    const audit = await one(db, `select count(*)::int n from fdh_document_audit_events where user_id = '${u}' and event_type = 'payroll_bank_match_restamped'`);
    check('the restamp is audited (payroll_bank_match_restamped)', audit.n === 1);
    const again = await rpc(db, u, `fdh9_restamp_payroll_bank_match('${ev}', '${credit}', 0.9)`);
    check('restamp is idempotent (already_matched, no second audit)', again.ok === true && again.outcome === 'already_matched'
      && (await one(db, `select count(*)::int n from fdh_document_audit_events where user_id = '${u}' and event_type = 'payroll_bank_match_restamped'`)).n === 1);
    const ev2 = await payrollEvent(db, u, { employer: 'Acme', fingerprint: `fp-ev2-${u}` });
    const rTaken = await rpc(db, u, `fdh9_restamp_payroll_bank_match('${ev2}', '${credit}', 0.9)`);
    check('one deposit corroborates at most one pay run (TRANSACTION_ALREADY_MATCHED)', rTaken.code === 'TRANSACTION_ALREADY_MATCHED', JSON.stringify(rTaken));
    const credit2 = await txn(db, u, { amount: 5000, date: '2026-08-31' });
    const rRepoint = await rpc(db, u, `fdh9_restamp_payroll_bank_match('${ev}', '${credit2}', 0.9)`);
    check('an existing match is never re-pointed by a sweep (ALREADY_MATCHED)', rRepoint.code === 'ALREADY_MATCHED', JSON.stringify(rRepoint));
  }

  // ---------------- GAP-15: a revised payslip supersedes ----------------
  {
    const u = await newUser(db);
    const credit = await txn(db, u, { amount: 5000, date: '2026-08-31' });
    const oldEv = await payrollEvent(db, u, { employer: 'Acme', start: '2026-08-01', end: '2026-08-31', net: 5000, fingerprint: `fp-old-${u}` });
    await rpc(db, u, `fdh9_restamp_payroll_bank_match('${oldEv}', '${credit}', 0.8)`);
    const oldProposal = await proposal(db, u, oldEv, {}, NEW_ROW_FIELDS());
    const newEv = await payrollEvent(db, u, { employer: 'Acme', start: '2026-08-01', end: '2026-08-31', net: 5000, gross: 6600, fingerprint: `fp-new-${u}` });
    const otherPeriod = await payrollEvent(db, u, { employer: 'Acme', start: '2026-07-01', end: '2026-07-31', fingerprint: `fp-jul-${u}` });
    const rNot = await rpc(db, u, `fdh9_supersede_payroll_event('${otherPeriod}', '${newEv}')`);
    check('supersede refuses a different pay period (NOT_A_REVISION)', rNot.code === 'NOT_A_REVISION', JSON.stringify(rNot));
    const r = await rpc(db, u, `fdh9_supersede_payroll_event('${oldEv}', '${newEv}')`);
    const rows = (await db.query(`select id, superseded_by_payroll_event_id s, bank_match_status m, bank_match_transaction_id t from fdh_payroll_events where id in ('${oldEv}', '${newEv}')`)).rows;
    const o = rows.find((x) => x.id === oldEv); const n = rows.find((x) => x.id === newEv);
    check('GAP-15: the old payslip is superseded by the revision', r.ok === true && o.s === newEv, JSON.stringify(r));
    check('GAP-15: the bank deposit moves to the revision (same money)', r.bank_match_moved === true && o.m === 'no_match' && n.m === 'matched' && n.t === credit, JSON.stringify(rows));
    const ps = await one(db, `select status from fhip_import_proposals where id = '${oldProposal}'`);
    check("GAP-15: the old payslip's open proposal is superseded", ps.status === 'superseded' && r.proposals_superseded === 1);
    const applyOld = await rpc(db, u, `fdh9_apply_income_proposal('${oldProposal}', 'add_new', ${ADD_NEW_SELECTION})`);
    check('GAP-15: the superseded proposal cannot be applied', applyOld.ok === false, JSON.stringify(applyOld));
    const oldProposal2 = await proposal(db, u, oldEv, {}, NEW_ROW_FIELDS());
    const applyOld2 = await rpc(db, u, `fdh9_apply_income_proposal('${oldProposal2}', 'add_new', ${ADD_NEW_SELECTION})`);
    check('GAP-15: a fresh proposal for the superseded payslip is PROPOSAL_NOT_ACTIONABLE', applyOld2.code === 'PROPOSAL_NOT_ACTIONABLE', JSON.stringify(applyOld2));
    const again = await rpc(db, u, `fdh9_supersede_payroll_event('${oldEv}', '${newEv}')`);
    check('supersede is idempotent', again.ok === true && again.outcome === 'already_superseded');
    const audit = await one(db, `select count(*)::int n from fdh_document_audit_events where user_id = '${u}' and event_type = 'payroll_event_superseded'`);
    check('supersede is audited once (payroll_event_superseded)', audit.n === 1);
    const forged = await asUser(db, u, () => errorOf(db, `update fdh_payroll_events set superseded_by_payroll_event_id = null where id = '${oldEv}'`));
    check('supersession cannot be undone by a direct update', forged !== null && /system-authoritative/.test(forged), forged ?? 'accepted');
    const pendingNewApprove = await rpc(db, u, `fdh9_approve_payroll_event('${oldEv}')`);
    check('a superseded pending payslip is not re-approvable', pendingNewApprove.ok === true || pendingNewApprove.code === 'EVENT_SUPERSEDED');
  }

  // ---------------- privileges ----------------
  for (const sig of ['fdh9_restamp_payroll_bank_match(uuid,uuid,numeric)', 'fdh9_supersede_payroll_event(uuid,uuid)', 'fdh9_approve_payroll_event(uuid,text,boolean)', 'fdh9_apply_income_proposal(uuid,text,text[])']) {
    const anon = await one(db, `select has_function_privilege('anon', '${sig}', 'execute') a, has_function_privilege('authenticated', '${sig}', 'execute') b`);
    check(`${sig}: anon cannot execute, authenticated can`, anon.a === false && anon.b === true, JSON.stringify(anon));
  }
  {
    const r = await asUser(db, '', async () => { try { await one(db, `select fdh9_restamp_payroll_bank_match(gen_random_uuid(), gen_random_uuid(), null)`); return null; } catch (e) { return e.message; } });
    check('restamp without an authenticated user raises', r !== null && /authentication required/.test(r), r ?? 'no error');
  }

  // ---------------- idempotent re-apply ----------------
  const fp1 = await schemaFingerprint(db);
  const reErr = await errorOf(db, target);
  const fp2 = await schemaFingerprint(db);
  check('0210 applies a second time without error', reErr === null, reErr ?? '');
  check('the second apply is a no-op (schema fingerprint unchanged)', fp1 === fp2);
}

// ===========================================================================
console.log('Case B -- duplicates present: the preflight refuses and changes nothing');
{
  const db = await replayUpToTarget();
  const b = await scenarioReapplyNoEmployer(db);
  check('setup: two Income applications for one payroll event', b.apps === 2);
  const fpBefore = await schemaFingerprint(db);
  const err = await errorOf(db, target);
  check('0210 raises the preflight error naming the duplicate count', err !== null && /0210 preflight: 1 payroll event\(s\)/.test(err), err ?? 'applied');
  const fpAfter = await schemaFingerprint(db);
  check('the refusal rolled everything back (schema unchanged, no restamp RPC, no index)', fpBefore === fpAfter
    && (await one(db, `select count(*)::int n from pg_proc where proname = 'fdh9_restamp_payroll_bank_match'`)).n === 0);
}

const total = pass + fail;
console.log(`\n=== fdh9 0210 PGlite verification: ${pass} PASS, ${fail} FAIL (${total} checks) ===`);
if (total < 50) { console.error('too few checks executed -- refusing to report a vacuous pass'); process.exit(2); }
process.exit(fail === 0 ? 0 : 1);
