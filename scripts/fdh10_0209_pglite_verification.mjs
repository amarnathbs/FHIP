// WP-11 -- migration 0209 (FDH-10 liability LEDGER Apply) verified on a freshly
// rebuilt REAL Postgres (PGlite/WASM) with this repository's full migration
// chain, using the auth.uid() / `set role authenticated` technique of
// scripts/fdh10_0208_pglite_verification.mjs.
//
// The economic oracles themselves (card 220 never 440; loan 2,000 = 1,550 +
// 430 + 20; drawdown; cash advance; repeat / overlap / 1,001 rows; read models
// over the real rows) are in tests/unit/fdh10ApplyLedgerPglite.test.ts. This
// script proves the MIGRATION: the defect before, the fix after, the guards,
// the trigger supersets, idempotency, zero rows rewritten, the loud pre-check,
// and that the oracle query can tell a broken mapping from the real one.
//
// Run: node scripts/fdh10_0209_pglite_verification.mjs   (exit 0 = all pass)
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const M0209 = '0209_fdh10_liability_apply_ledger.sql';
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
if (!files.includes(M0209)) { console.error('FAIL  migration 0209 not found'); process.exit(2); }
const sqlOf = (f) => fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const SQL_0209 = sqlOf(M0209);

async function build(stopBefore) {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
  for (const f of files) {
    if (stopBefore && f >= stopBefore) break;
    await db.exec(sqlOf(f));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  return db;
}

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, message: e.message }; } };

function harness(db) {
  const svc = async () => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  const asTenant = async (uid, fn) => {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await db.exec('set role authenticated;');
    try { return await fn(); } finally { await db.exec('reset role;'); await svc(); }
  };
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
  const user = async (uid) => {
    await svc();
    await db.query(`insert into auth.users(id, email) values ($1, $2)`, [uid, `${uid}@t.test`]);
    await db.query(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`, [uid]);
  };
  const bankDebit = async (uid, amount, date) => {
    await svc();
    const acc = await one(`insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name) values ($1,'transaction','AU','AUD','Bank') returning id`, [uid]);
    const up = await one(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status) values ($1,'csv','bank_statement','AU','AUD','text/csv','approved') returning id`, [uid]);
    return (await one(`insert into fdh_transactions (user_id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type, approval_status, approved_at, approved_by)
                       values ($1,$2,$3,$4,$5,'AUD','debit','expense','approved',now(),$1) returning id`, [uid, acc.id, up.id, date, amount])).id;
  };
  // An approved card statement (200 + 20 purchases, 220 repayment matched to `bank`) with a READY add_new proposal.
  const cardStatement = async (uid, bank) => {
    await svc();
    const up = await one(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status) values ($1,'csv','credit_card_statement','AU','AUD','text/csv','extracted') returning id`, [uid]);
    const st = await one(`insert into fdh_liability_statements (user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code, statement_period_start, statement_period_end, closing_balance, approval_status, approved_at, approved_by)
                          values ($1,$2,'credit_card','credit_card','AU','AUD','2026-08-01','2026-08-31',1000,'approved',now(),$1) returning id`, [uid, up.id]);
    const act = async (type, amount, date, extra = {}) => (await one(
      `insert into fdh_liability_statement_activities (user_id, statement_id, activity_type, activity_date, amount, currency_code, description_raw, linked_transaction_id, bank_match_status, source_row_number)
       values ($1,$2,$3,$4,$5,'AUD',$6,$7,$8,$9) returning id`,
      [uid, st.id, type, date, amount, `${type} ${amount}`, extra.linked ?? null, extra.linked ? 'matched' : 'not_attempted', extra.row])).id;
    await act('PURCHASE', 200, '2026-08-03', { row: 1 });
    await act('PURCHASE', 20, '2026-08-05', { row: 2 });
    await act('PAYMENT', 220, '2026-08-20', { row: 3, linked: bank });
    const pr = await one(`insert into fhip_import_proposals (user_id, target_domain, source_kind, source_liability_statement_id, currency_code, recommended_apply_mode, status) values ($1,'liability','credit_card_statement',$2,'AUD','add_new','ready') returning id`, [uid, st.id]);
    for (const [f, k, v] of [['liability_name', 'text', 'Card'], ['debt_type', 'enum', 'credit_card'], ['balance', 'money', '1000'], ['currency_code', 'enum', 'AUD']]) {
      await db.query(`insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value) values ($1,$2,$3,$4,$5)`, [uid, pr.id, f, k, v]);
    }
    return { statementId: st.id, proposalId: pr.id, uploadId: up.id };
  };
  // The ORACLE query: household spending = expense-typed approved rows (no split) + expense allocations,
  // excluding a bank leg a confirmed settlement link pairs with a facility row.
  const spending = async (uid) => Number((await one(
    `select coalesce(sum(x.amount), 0)::text s from (
       select t.amount_original amount from fdh_transactions t
        where t.user_id = $1 and t.approval_status = 'approved' and t.economic_transaction_type = 'expense'
          and not exists (select 1 from fdh_transaction_allocations a where a.transaction_id = t.id)
          and not exists (select 1 from fdh_transaction_links l where l.transaction_id_from = t.id and l.status = 'confirmed'
                          and l.link_type in ('credit_card_settlement','loan_payment') and l.transaction_id_to is not null)
       union all
       select a.amount from fdh_transaction_allocations a join fdh_transactions t on t.id = a.transaction_id
        where t.user_id = $1 and t.approval_status = 'approved' and a.economic_transaction_type = 'expense') x`, [uid])).s);
  return { svc, asTenant, one, user, bankDebit, cardStatement, spending };
}

// Parses the protected column list of a trigger function body.
const protectedCols = (body) => new Set([...body.matchAll(/new\.([a-z_]+) is distinct from old\.\1/g)].map((m) => m[1]));
const fnBody = (sql, name) => {
  const re = new RegExp(`create or replace function ${name}\\(\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, 'g');
  const all = [...sql.matchAll(re)];
  return all.length ? all[all.length - 1][1] : null;
};

// ===========================================================================
console.log('=== 1. NEGATIVE CONTROL: the pre-0209 Apply writes no ledger, and a GUC cannot complete a link ===');
const pre = await build(M0209);
{
  const h = harness(pre);
  const A = '11111111-1111-1111-1111-111111111111';
  await h.user(A);
  const bank = await h.bankDebit(A, 220, '2026-08-20');
  const s = await h.cardStatement(A, bank);
  const r = await h.asTenant(A, async () => (await h.one(`select fdh10_apply_liability_proposal($1::uuid,'add_new',array['liability_name','debt_type','balance','currency_code']) r`, [s.proposalId])).r);
  check('pre-0209: Apply succeeds (the liability is written)', r.ok === true, JSON.stringify(r));
  const n = Number((await h.one(`select count(*) n from fdh_transactions where user_id = $1`, [A])).n);
  check('pre-0209: NO ledger row for the 3 approved activities (G1) -- only the bank debit exists', n === 1, `rows=${n}`);
  check('pre-0209: household spending by the oracle query = 220 (the bank debit, typed expense, unlinked)', (await h.spending(A)) === 220);
  // The r8 link trigger is not GUC-aware before 0209: an internal writer could not complete an open link.
  await h.svc();
  const link = await h.one(`insert into fdh_transaction_links (user_id, transaction_id_from, link_type, created_by_method, status) values ($1,$2,'credit_card_settlement','algorithm','pending') returning id`, [A, bank]);
  // One simple-query message = one transaction, so the transaction-local GUC
  // really is set for the UPDATE (a separate statement would not see it).
  const withGuc = (linkId, toId) => h.asTenant(A, () => pre.exec(
    `select set_config('fhip.import_bridge_internal_write','true',true); update fdh_transaction_links set transaction_id_to = '${toId}' where id = '${linkId}';`));
  const guard = await attempt(() => h.asTenant(A, () => pre.query(`select set_config('fhip.import_bridge_internal_write','true',true) g, current_setting('fhip.import_bridge_internal_write') v`)));
  check('control: the GUC is visible inside one statement', guard.ok && guard.value.rows[0].v === 'true');
  const upd = await attempt(() => withGuc(link.id, bank));
  check('pre-0209: even with the internal-write GUC set in the same transaction, completing a link is refused (why 0209 section C exists)', !upd.ok && /authoritative match fields/.test(upd.message), upd.message ?? 'UPDATED');
  globalThis.__fdh10LinkProbe = { linkId: link.id, withGuc };
  const fnCount = Number((await h.one(`select count(*) n from pg_proc where proname = 'fdh10_apply_liability_proposal' and pronargs = 3`)).n);
  check('pre-0209: the 3-argument Apply exists', fnCount === 1);
}

// Capture existing rows' xmin to prove 0209 rewrites none.
const xminBefore = (await pre.query(`select id::text, xmin::text from fdh_liability_statements union all select id::text, xmin::text from fdh_liability_statement_activities order by 1`)).rows;

console.log('\n=== 2. Apply 0209 to the SAME database ===');
await pre.exec(SQL_0209);
{
  const h = harness(pre);
  const xminAfter = (await pre.query(`select id::text, xmin::text from fdh_liability_statements union all select id::text, xmin::text from fdh_liability_statement_activities order by 1`)).rows;
  check('zero rows rewritten: every existing statement/activity keeps its xmin', JSON.stringify(xminBefore) === JSON.stringify(xminAfter), `${xminAfter.length} rows`);
  const fns = (await pre.query(`select pronargs from pg_proc where proname = 'fdh10_apply_liability_proposal'`)).rows;
  check('exactly ONE Apply function remains (5 arguments, two defaulted) -- PostgREST never sees two candidates', fns.length === 1 && fns[0].pronargs === 5, JSON.stringify(fns));
  const priv = async (role, fn) => (await h.one(`select has_function_privilege($1, $2, 'execute') p`, [role, fn])).p;
  check('authenticated may execute the Apply, the backfill and the match RPCs',
    (await priv('authenticated', 'fdh10_apply_liability_proposal(uuid,text,text[],text,boolean)'))
    && (await priv('authenticated', 'fdh10_record_liability_statement_ledger(uuid,text,boolean)'))
    && (await priv('authenticated', 'fdh10_match_liability_payment(uuid,uuid,text)')));
  check('anon may NOT execute the Apply', !(await priv('anon', 'fdh10_apply_liability_proposal(uuid,text,text[],text,boolean)')));
  for (const fn of ['fdh10_internal_write_statement_ledger(uuid,uuid,uuid,text,boolean)', 'fdh10_internal_link_payment_leg(uuid,uuid,uuid,uuid,text)', 'fdh10_internal_ledger_blockers(uuid,uuid,boolean)']) {
    check(`internal helper not executable by authenticated or anon: ${fn}`, !(await priv('authenticated', fn)) && !(await priv('anon', fn)));
  }
  const A = '11111111-1111-1111-1111-111111111111';
  const back = await h.asTenant(A, async () => (await h.one(`select fdh10_record_liability_statement_ledger(id) r from fdh_liability_statements where user_id = $1`, [A])).r);
  check('the statement applied under 0096 is recorded once by the backfill RPC: 3 rows, and the bank debit open settlement link (from section 1) is COMPLETED, not duplicated', back.ok === true && back.ledger.transactions_created === 3 && back.ledger.links_completed === 1 && back.ledger.links_created === 0, JSON.stringify(back.ledger));
  check('...and household spending by the SAME oracle query is now 220 from the card, the bank debit being a settled transfer', (await h.spending(A)) === 220);
  const bankType = (await h.one(`select economic_transaction_type t from fdh_transactions where user_id = $1 and source_row_hash is null`, [A])).t;
  check('...the bank debit was reclassified to transfer with correction evidence', bankType === 'transfer', bankType);
  const cardExpense = Number((await h.one(`select coalesce(sum(amount_original),0)::text s from fdh_transactions where user_id = $1 and source_row_hash like 'fdh10:act:%' and economic_transaction_type = 'expense'`, [A])).s);
  check('...the two card purchases are the expense (200 + 20)', cardExpense === 220, String(cardExpense));
  const probeLink = await h.one(`insert into fdh_transaction_links (user_id, transaction_id_from, link_type, created_by_method, status) select $1, id, 'internal_transfer', 'algorithm', 'pending' from fdh_transactions where user_id = $1 and source_row_hash is null limit 1 returning id`, [A]);
  const target = (await h.one(`select id from fdh_transactions where user_id = $1 and source_row_hash like 'fdh10:act:%' limit 1`, [A])).id;
  const withGucAfter = await attempt(() => h.asTenant(A, () => pre.exec(`select set_config('fhip.import_bridge_internal_write','true',true); update fdh_transaction_links set transaction_id_to = '${target}' where id = '${probeLink.id}';`)));
  check('POSITIVE control after 0209: the SAME GUC-in-transaction update now passes the link trigger (the internal-write path)', withGucAfter.ok, withGucAfter.message ?? '');
  const withoutGuc = await attempt(() => h.asTenant(A, () => pre.query(`update fdh_transaction_links set transaction_id_to = null where id = $1`, [probeLink.id])));
  check('...while WITHOUT the GUC the authenticated rules are unchanged (refused)', !withoutGuc.ok && /authoritative match fields/.test(withoutGuc.message), withoutGuc.message ?? 'UPDATED');
}

console.log('\n=== 3. Authoritative-write triggers: strict supersets, and they bite ===');
{
  const f1Pre = protectedCols(fnBody(sqlOf('0186_fdh10_liability_statement_user_correction.sql'), 'fdh10_liability_statements_assert_authoritative_write'));
  const f1Post = protectedCols(fnBody(SQL_0209, 'fdh10_liability_statements_assert_authoritative_write'));
  const f2Pre = protectedCols(fnBody(sqlOf('0208_fdh10_atomic_liability_statement_persist.sql'), 'fdh10_liability_activities_assert_authoritative_write'));
  const f2Post = protectedCols(fnBody(SQL_0209, 'fdh10_liability_activities_assert_authoritative_write'));
  const r8Pre = protectedCols(fnBody(sqlOf('0068_r8_transaction_classification_engine.sql'), 'r8_assert_transaction_link_authoritative_fields'));
  const r8Post = protectedCols(fnBody(SQL_0209, 'r8_assert_transaction_link_authoritative_fields'));
  const superset = (a, b) => [...a].every((c) => b.has(c));
  check('F.1 (statements) 0209 protects every column 0186 protected, plus the ledger columns', superset(f1Pre, f1Post) && f1Post.has('ledger_status') && f1Post.has('extraction_warnings') && f1Pre.size >= 30, `${f1Pre.size} -> ${f1Post.size}`);
  check('F.2 (activities) 0209 protects every column 0208 protected, plus the ledger disposition', superset(f2Pre, f2Post) && f2Post.has('ledger_disposition') && f2Pre.has('bank_match_candidate_ids'), `${f2Pre.size} -> ${f2Post.size}`);
  check('r8 link trigger: the authenticated-role rules are unchanged (the same 8 guarded columns)', r8Pre.size === 8 && [...r8Pre].every((c) => r8Post.has(c)) && r8Pre.size === r8Post.size, `${r8Pre.size} / ${r8Post.size}`);
  const h = harness(pre);
  const A = '11111111-1111-1111-1111-111111111111';
  for (const [table, set] of [['fdh_liability_statements', `ledger_status = 'rejected'`], ['fdh_liability_statements', `extraction_warnings = '[{"code":"x"}]'`], ['fdh_liability_statement_activities', `ledger_disposition = 'rejected'`], ['fdh_liability_statement_activities', `ledger_transaction_id = null`]]) {
    const r = await attempt(() => h.asTenant(A, () => pre.query(`update ${table} set ${set} where user_id = $1`, [A])));
    check(`authenticated direct UPDATE refused: ${table}.${set.split(' ')[0]}`, !r.ok && /system-authoritative/.test(r.message), r.message ?? 'UPDATED');
  }
  const link = await attempt(() => h.asTenant(A, () => pre.query(`update fdh_transaction_links set transaction_id_to = null where user_id = $1`, [A])));
  check('authenticated cannot un-complete a settlement link directly', !link.ok && /authoritative match fields/.test(link.message), link.message ?? 'UPDATED');
  const ins = await attempt(() => h.asTenant(A, () => pre.query(`insert into fdh_transactions (user_id, financial_account_id, transaction_date, amount_original, currency_original, credit_debit) select $1, id, '2026-08-01', 1, 'AUD', 'debit' from fdh_financial_accounts where user_id = $1 limit 1`, [A])));
  check('authenticated direct INSERT into fdh_transactions still refused (r7)', !ins.ok && /engine-authoritative/.test(ins.message), ins.message ?? 'INSERTED');
}

console.log('\n=== 4. Idempotent: a second apply of 0209 changes nothing ===');
{
  const snap = async () => JSON.stringify((await pre.query(`
    select 'f:' || p.proname || '/' || md5(p.prosrc) x from pg_proc p where p.proname like 'fdh10_%' or p.proname like 'r8_assert_transaction_link%' or p.proname like 'fdh0209_%'
    union all select 'i:' || indexname || md5(indexdef) from pg_indexes where indexname like '%0209%'
    union all select 'c:' || conname || md5(pg_get_constraintdef(oid)) from pg_constraint where conname like '%0209%'
    union all select 't:' || tgname from pg_trigger where tgname like '%0209%'
    order by 1`)).rows);
  const before = await snap();
  const again = await attempt(() => pre.exec(SQL_0209));
  check('re-applying 0209 raises nothing', again.ok, again.message ?? '');
  check('re-applying 0209 changes no function body, index, constraint or trigger', before === (await snap()));
  check('...and still exactly one Apply function', Number((await harness(pre).one(`select count(*) n from pg_proc where proname = 'fdh10_apply_liability_proposal'`)).n) === 1);
}

console.log('\n=== 5. The loud pre-check refuses to build the unique index over duplicates ===');
{
  const db = await build(M0209);
  const h = harness(db);
  const B = '22222222-2222-2222-2222-222222222222';
  await h.user(B);
  const bank = await h.bankDebit(B, 220, '2026-08-20');
  const s = await h.cardStatement(B, bank);
  await h.svc();
  await db.query(`insert into fhip_import_proposals (user_id, target_domain, source_kind, source_liability_statement_id, currency_code, recommended_apply_mode, status) values ($1,'liability','credit_card_statement',$2,'AUD','add_new','ready')`, [B, s.statementId]);
  const r = await attempt(() => db.exec(SQL_0209));
  check('two ready proposals for one statement -> 0209 raises PRE-CHECK FAILED', !r.ok && /0209 PRE-CHECK FAILED: 1 liability statement/.test(r.message), r.message ?? 'APPLIED');
  const cols = Number((await h.one(`select count(*) n from information_schema.columns where table_name = 'fdh_liability_statements' and column_name = 'ledger_status'`)).n);
  const args = (await h.one(`select pronargs from pg_proc where proname = 'fdh10_apply_liability_proposal'`)).pronargs;
  check('...and NOTHING of 0209 was applied (no column, the old 3-arg Apply still in place)', cols === 0 && args === 3, `cols=${cols} args=${args}`);
  await db.close();
}

console.log('\n=== 6. ANTI-VACUITY: the oracle query tells a broken ledger mapping from the real one ===');
{
  const mutated = SQL_0209
    .replace("when 'PAYMENT' then 'transfer'", "when 'PAYMENT' then 'expense'")
    .replace("if v_act.activity_type in ('PAYMENT', 'PRINCIPAL') and v_act.bank_match_status = 'matched'", "if false and v_act.activity_type in ('PAYMENT', 'PRINCIPAL') and v_act.bank_match_status = 'matched'");
  check('the mutation really changed the SQL (2 edits)', mutated !== SQL_0209 && (mutated.match(/if false and/g) ?? []).length === 1);
  const db = await build(M0209);
  await db.exec(mutated);
  const h = harness(db);
  const C = '33333333-3333-3333-3333-333333333333';
  await h.user(C);
  const bank = await h.bankDebit(C, 220, '2026-08-20');
  const s = await h.cardStatement(C, bank);
  const r = await h.asTenant(C, async () => (await h.one(`select fdh10_apply_liability_proposal($1::uuid,'add_new',array['liability_name','debt_type','balance','currency_code']) r`, [s.proposalId])).r);
  check('mutated Apply runs', r.ok === true, JSON.stringify(r).slice(0, 120));
  const spend = await h.spending(C);
  check('with the repayment typed expense and no settlement link, the oracle reports 660 (440 of it double counting) -- NOT 220', spend === 660, String(spend));
  await db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
