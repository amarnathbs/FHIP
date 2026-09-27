/**
 * PGlite probe (read-only w.r.t. any real database): after a liability statement is APPLIED, can the rows be
 * deleted at all? The DEV residue cleanup found the chain liabilities <-> fhip_import_applications <->
 * fdh_liability_statements undeletable through the service role, because the FK actions
 * (ON DELETE SET NULL on liabilities.last_import_application_id, fdh_liability_statements.liability_id,
 * fdh_financial_accounts.liability_id) fire the 0096 authoritative-write guards. This probe replays the full
 * migration chain and tests:
 *   1. service-role DELETE of the applied liability / its application     (expected to be blocked - observed on DEV)
 *   2. DELETE of the auth user (account deletion cascade)                  (the question that matters)
 *
 *   node scripts/canonical_cert/econ/pglite_liability_delete_probe.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, '..', '..');
const ROOT = path.resolve(SCRIPTS, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const sqlOf = (f) => fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(SCRIPTS, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
for (const f of files) { await db.exec(sqlOf(f)); if (f.startsWith('0001')) await db.exec(seed); }
console.log(`replayed ${files.length} migrations (last ${files.at(-1)})`);

const svc = async () => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
const asTenant = async (uid, fn) => {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated;');
  try { return await fn(); } finally { await db.exec('reset role;'); await svc(); }
};
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, message: e.message }; } };

async function appliedCardUser(uid) {
  await svc();
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [uid, `${uid}@t.test`]);
  await db.query(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`, [uid]);
  const acc = await one(`insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name) values ($1,'transaction','AU','AUD','Bank') returning id`, [uid]);
  const bup = await one(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status) values ($1,'csv','bank_statement','AU','AUD','text/csv','approved') returning id`, [uid]);
  const bank = (await one(`insert into fdh_transactions (user_id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type, approval_status, approved_at, approved_by) values ($1,$2,$3,'2026-08-20',220,'AUD','debit','transfer','approved',now(),$1) returning id`, [uid, acc.id, bup.id])).id;
  const up = await one(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status) values ($1,'csv','credit_card_statement','AU','AUD','text/csv','extracted') returning id`, [uid]);
  const st = await one(`insert into fdh_liability_statements (user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code, statement_period_start, statement_period_end, closing_balance, approval_status, approved_at, approved_by) values ($1,$2,'credit_card','credit_card','AU','AUD','2026-08-01','2026-08-31',1000,'approved',now(),$1) returning id`, [uid, up.id]);
  for (const [t, a, d, row, linked] of [['PURCHASE', 200, '2026-08-03', 1, null], ['PAYMENT', 220, '2026-08-20', 3, bank]]) {
    await db.query(`insert into fdh_liability_statement_activities (user_id, statement_id, activity_type, activity_date, amount, currency_code, description_raw, linked_transaction_id, bank_match_status, source_row_number) values ($1,$2,$3,$4,$5,'AUD',$6,$7,$8,$9)`,
      [uid, st.id, t, d, a, `${t} ${a}`, linked, linked ? 'matched' : 'not_attempted', row]);
  }
  const pr = await one(`insert into fhip_import_proposals (user_id, target_domain, source_kind, source_liability_statement_id, currency_code, recommended_apply_mode, status) values ($1,'liability','credit_card_statement',$2,'AUD','add_new','ready') returning id`, [uid, st.id]);
  for (const [f, k, v] of [['liability_name', 'text', 'Card'], ['debt_type', 'enum', 'credit_card'], ['balance', 'money', '1000'], ['currency_code', 'enum', 'AUD']]) {
    await db.query(`insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value) values ($1,$2,$3,$4,$5)`, [uid, pr.id, f, k, v]);
  }
  const r = await asTenant(uid, async () => (await one(`select fdh10_apply_liability_proposal($1::uuid,'add_new',array['liability_name','debt_type','balance','currency_code']) r`, [pr.id])).r);
  return { r, st: st.id };
}

let pass = 0, fail = 0;
const report = (label, cond, detail) => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${detail ?? ''}`); };

// 1. service-role deletes of the applied chain (what the DEV residue cleanup hit)
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const a = await appliedCardUser(A);
report('probe setup: Apply succeeded (liability + application + ledger)', a.r?.ok === true, JSON.stringify(a.r).slice(0, 200));
const liabId = a.r.target_entity_id ?? (await one(`select id from liabilities where user_id=$1`, [A])).id;
await svc();
const delLiab = await attempt(() => db.query(`delete from liabilities where id = $1`, [liabId]));
report('observation: service-role DELETE of the applied liability is refused by a guard', !delLiab.ok, delLiab.message ?? 'DELETED');
const delApp = await attempt(() => db.query(`delete from fhip_import_applications where user_id = $1`, [A]));
report('observation: service-role DELETE of its application is refused by a guard', !delApp.ok, delApp.message ?? 'DELETED');

// 2. account deletion (auth.users cascade)
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const b = await appliedCardUser(B);
report('probe setup (user B): Apply succeeded', b.r?.ok === true);
await svc();
const delUser = await attempt(() => db.query(`delete from auth.users where id = $1`, [B]));
const left = delUser.ok ? Number((await one(`select (select count(*) from liabilities where user_id=$1) + (select count(*) from fdh_liability_statements where user_id=$1) + (select count(*) from fhip_import_applications where user_id=$1) n`, [B])).n) : null;
report('QUESTION: deleting the auth user (account deletion) succeeds and leaves no liability/statement/application rows', delUser.ok && left === 0, delUser.ok ? `rows left ${left}` : delUser.message);

// 3. the PO's residue SQL pattern (dev_residue_B_liability_chains.sql): ONE transaction, the internal-write
//    GUC, delete order applications -> proposals -> liabilities -> statements -> accounts -> uploads.
const C = 'cccccccc-0000-4000-8000-00000000000c';
const c = await appliedCardUser(C);
report('probe setup (user C): Apply succeeded', c.r?.ok === true);
await svc();
const q = async (sql) => (await db.query(sql, [C])).rows.map((r) => r.id);
const chain = {
  fhip_import_applications: await q(`select id from fhip_import_applications where user_id = $1`),
  fhip_import_proposals: await q(`select id from fhip_import_proposals where user_id = $1`),
  liabilities: await q(`select id from liabilities where user_id = $1`),
  fdh_liability_statements: await q(`select id from fdh_liability_statements where user_id = $1`),
  fdh_financial_accounts: await q(`select id from fdh_financial_accounts where user_id = $1 and liability_id is not null`),
  fdh_statement_uploads: await q(`select statement_upload_id id from fdh_liability_statements where user_id = $1`),
};
const withoutGuc = await attempt(() => db.exec(`delete from liabilities where id = '${chain.liabilities[0]}';`));
report('residue SQL control: WITHOUT the GUC the liability delete is refused', !withoutGuc.ok, withoutGuc.message);
// Facility-account ledger rows reference the account; the DEV run's cleanup already removed them (they have a
// user column), so remove them here first to reproduce the same state.
await db.exec(`delete from fdh_liability_statement_activities where user_id = '${C}'; delete from fdh_transaction_links where user_id = '${C}'; delete from fdh_transaction_allocations where user_id = '${C}'; delete from fdh_transactions where user_id = '${C}' and financial_account_id in (${chain.fdh_financial_accounts.map((i) => `'${i}'`).join(',')});`);
const sql = ['begin;', "select set_config('fhip.import_bridge_internal_write', 'true', true);",
  ...Object.entries(chain).filter(([, v]) => v.length).map(([t, v]) => `delete from ${t} where id in (${v.map((i) => `'${i}'`).join(', ')});`), 'commit;'].join('\n');
const withGuc = await attempt(() => db.exec(sql));
const leftC = Number((await one(`select (select count(*) from liabilities where user_id=$1) + (select count(*) from fdh_liability_statements where user_id=$1) + (select count(*) from fhip_import_applications where user_id=$1) + (select count(*) from fhip_import_proposals where user_id=$1) n`, [C])).n);
report('residue SQL: with the GUC in one transaction the whole chain deletes, 0 rows left', withGuc.ok && leftC === 0, withGuc.ok ? `left ${leftC}` : withGuc.message);
console.log(`\n${pass} pass, ${fail} fail`);
