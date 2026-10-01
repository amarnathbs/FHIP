// Owner-before-upload PHASE 1 -- PGlite verification for migration
// 0236_owner_before_upload_phase1.sql.
//
// What this proves (each with a named, observable failure if the migration is
// wrong -- the negative controls are the BEFORE-state failures and the refused
// writes, not an absence of errors):
//   1. anti-vacuity: BEFORE 0236 the owner columns do not exist (a select of
//      them fails), so every PASS below is the migration's doing.
//   2. 0236 applies cleanly, and applies a SECOND time with no error and no
//      change to the constraint / trigger / policy inventory (idempotent).
//   3. The constraints refuse: an unknown owner_role; both a member AND an
//      entity; an entity with a person's role; a user_selected owner with no
//      role; a joint document with no allocation; an allocation that does not
//      sum to 10000, has a duplicate owner, a zero share, or one owner only.
//   4. The cross-tenant trigger refuses another user's household member and
//      another user's entity on BOTH tables (and accepts the caller's own).
//   5. RLS is untouched: the policy inventory of both tables is identical
//      before and after, and a user still cannot read another user's rows.
//   6. Existing writes still work: a legacy insert (no owner columns) succeeds
//      and lands with NULL owner columns (nothing invented).
//
// Run: node scripts/owner_before_upload_0236_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0236_owner_before_upload_phase1.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const target = strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const errOf = async (db, sql, params) => { try { if (params) await db.query(sql, params); else await db.exec(sql); return null; } catch (e) { return e; } };
const codeOf = (e) => (e ? (e.code ?? e.message) : null);

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
for (const f of files) {
  if (f >= TARGET) break;
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const MEM_A = 'a1111111-1111-4111-8111-111111111111';
const MEM_A2 = 'a2222222-2222-4222-8222-222222222222';
const MEM_B = 'b1111111-1111-4111-8111-111111111111';
const ENT_A = 'e1111111-1111-4111-8111-111111111111';
const ENT_B = 'e2222222-2222-4222-8222-222222222222';

console.log('Owner-before-upload Phase 1 -- 0236 verification');

const inventory = async () => {
  const c = await db.query(`select conrelid::regclass::text t, conname from pg_constraint where conrelid in ('public.fdh_statement_uploads'::regclass, 'public.ii_source_documents'::regclass, 'public.aie_document_intake'::regclass) order by 1, 2`);
  const t = await db.query(`select event_object_table t, trigger_name from information_schema.triggers where event_object_table in ('fdh_statement_uploads','ii_source_documents') group by 1,2 order by 1,2`);
  const p = await db.query(`select tablename, policyname, cmd, qual, with_check from pg_policies where tablename in ('fdh_statement_uploads','ii_source_documents') order by 1, 2`);
  return { c: JSON.stringify(c.rows), t: JSON.stringify(t.rows), p: JSON.stringify(p.rows) };
};

// ---- 1. anti-vacuity ---------------------------------------------------------
{
  const e1 = await errOf(db, `select owner_role from fdh_statement_uploads limit 1`);
  const e2 = await errOf(db, `select owner_business_entity_id, owner_allocation, owner_review from ii_source_documents limit 1`);
  check('anti-vacuity: BEFORE 0236 fdh_statement_uploads.owner_role does not exist', e1 !== null && /owner_role/.test(e1.message), e1?.message);
  check('anti-vacuity: BEFORE 0236 ii_source_documents.owner_allocation does not exist', e2 !== null, e2?.message);
}
const before = await inventory();

// ---- 2. apply, then apply again ---------------------------------------------
{
  const e = await errOf(db, target);
  check('0236 applies cleanly', e === null, e?.message);
  const afterFirst = await inventory();
  const e2 = await errOf(db, target);
  check('0236 applies a SECOND time without error (idempotent)', e2 === null, e2?.message);
  const afterSecond = await inventory();
  check('second run changes nothing: constraints, triggers and policies identical', afterFirst.c === afterSecond.c && afterFirst.t === afterSecond.t && afterFirst.p === afterSecond.p);
  check('RLS untouched: the policy inventory is identical BEFORE and AFTER 0236', before.p === afterSecond.p);
  const added = JSON.parse(afterSecond.c).filter((r) => /_0236$/.test(r.conname)).length;
  check('13 new named constraints (6 on uploads, 6 on ii_source_documents, 1 on aie_document_intake)', added === 13, `found ${added}`);
}

// ---- seed ---------------------------------------------------------------------
await db.exec(`insert into auth.users(id, email) values ('${A}', 'a@t.test'), ('${B}', 'b@t.test') on conflict do nothing`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id in ('${A}','${B}')`);
await db.exec(`insert into household_members(id, user_id, full_name, relationship) values
  ('${MEM_A}', '${A}', 'Anil A', 'self'), ('${MEM_A2}', '${A}', 'Priya A', 'spouse'), ('${MEM_B}', '${B}', 'Bob B', 'self')`);
await db.exec(`insert into business_entities(id, user_id, name, entity_type) values ('${ENT_A}', '${A}', 'A Family Trust', 'family_trust'), ('${ENT_B}', '${B}', 'B Trust', 'family_trust')`);

const up = (cols, vals) => `insert into fdh_statement_uploads (user_id, source_type, document_type, ${cols}) values ('${A}', 'csv', 'bank_statement', ${vals})`;
const iiDoc = (cols, vals) => `insert into ii_source_documents (user_id, country_code, status, storage_path, original_filename, mime_type, file_size, document_type${cols ? ', ' + cols : ''}) values ('${A}', 'IN', 'uploaded', 'k/${Math.random()}', 'f.pdf', 'application/pdf', 10, 'cas_statement'${vals ? ', ' + vals : ''})`;

// ---- 6. legacy write still works, nothing invented ---------------------------
{
  const e = await errOf(db, `insert into fdh_statement_uploads (user_id, source_type, document_type) values ('${A}', 'csv', 'bank_statement')`);
  check('a legacy fdh_statement_uploads insert (no owner columns) still succeeds', e === null, e?.message);
  const e2 = await errOf(db, iiDoc('', ''));
  check('a legacy ii_source_documents insert (no owner columns) still succeeds', e2 === null, e2?.message);
  const r = await db.query(`select count(*)::int n from fdh_statement_uploads where owner_role is not null or owner_selection_source is not null`);
  check('nothing invented: legacy rows keep NULL owner columns', r.rows[0].n === 0);
}

// ---- 3. constraints ------------------------------------------------------------
{
  const ok = await errOf(db, up('owner_member_id, owner_role, owner_selection_source', `'${MEM_A}', 'self', 'user_selected'`));
  check('a valid user-selected member-owned upload is accepted', ok === null, ok?.message);
  const okEnt = await errOf(db, up('owner_business_entity_id, owner_role, owner_selection_source', `'${ENT_A}', 'family_trust', 'user_selected'`));
  check('a valid user-selected entity-owned upload is accepted', okEnt === null, okEnt?.message);

  check('NEGATIVE: unknown owner_role is refused (chk_fdh_uploads_owner_role_0236)', codeOf(await errOf(db, up('owner_role', `'bogus'`))) === '23514');
  check('NEGATIVE: a member AND an entity together are refused (one_kind)', codeOf(await errOf(db, up('owner_member_id, owner_business_entity_id, owner_role', `'${MEM_A}', '${ENT_A}', 'other'`))) === '23514');
  check('NEGATIVE: an entity id with a person role is refused (entity_role)', codeOf(await errOf(db, up('owner_business_entity_id, owner_role', `'${ENT_A}', 'self'`))) === '23514');
  check('NEGATIVE: user_selected with no owner_role is refused (chosen_has_role)', codeOf(await errOf(db, up('owner_selection_source', `'user_selected'`))) === '23514');
  check('NEGATIVE: unknown owner_selection_source is refused', codeOf(await errOf(db, up('owner_selection_source', `'guess'`))) === '23514');

  const alloc = (arr) => `'${JSON.stringify(arr)}'::jsonb`;
  const jointCols = 'owner_role, owner_selection_source, owner_allocation';
  const good = [{ ownerMemberId: MEM_A, basisPoints: 6000 }, { ownerMemberId: MEM_A2, basisPoints: 4000 }];
  check('a valid joint document (6000 + 4000) is accepted', (await errOf(db, iiDoc(jointCols, `'joint', 'user_selected', ${alloc(good)}`))) === null);
  check('a joint split across a member and an entity is accepted', (await errOf(db, iiDoc(jointCols, `'joint', 'user_selected', ${alloc([{ ownerMemberId: MEM_A, basisPoints: 5000 }, { ownerBusinessEntityId: ENT_A, basisPoints: 5000 }])}`))) === null);
  check('NEGATIVE: joint total 9999 is refused (joint_alloc)', codeOf(await errOf(db, iiDoc(jointCols, `'joint', 'user_selected', ${alloc([{ ownerMemberId: MEM_A, basisPoints: 5999 }, { ownerMemberId: MEM_A2, basisPoints: 4000 }])}`))) === '23514');
  check('NEGATIVE: joint total 10001 is refused', codeOf(await errOf(db, iiDoc(jointCols, `'joint', 'user_selected', ${alloc([{ ownerMemberId: MEM_A, basisPoints: 6001 }, { ownerMemberId: MEM_A2, basisPoints: 4000 }])}`))) === '23514');
  check('NEGATIVE: a duplicate owner in the split is refused', codeOf(await errOf(db, iiDoc(jointCols, `'joint', 'user_selected', ${alloc([{ ownerMemberId: MEM_A, basisPoints: 5000 }, { ownerMemberId: MEM_A, basisPoints: 5000 }])}`))) === '23514');
  check('NEGATIVE: a zero share is refused', codeOf(await errOf(db, iiDoc(jointCols, `'joint', 'user_selected', ${alloc([{ ownerMemberId: MEM_A, basisPoints: 10000 }, { ownerMemberId: MEM_A2, basisPoints: 0 }])}`))) === '23514');
  check('NEGATIVE: a single-owner "joint" split is refused', codeOf(await errOf(db, iiDoc(jointCols, `'joint', 'user_selected', ${alloc([{ ownerMemberId: MEM_A, basisPoints: 10000 }])}`))) === '23514');
  check('NEGATIVE: an element naming both a member and an entity is refused', codeOf(await errOf(db, iiDoc(jointCols, `'joint', 'user_selected', ${alloc([{ ownerMemberId: MEM_A, ownerBusinessEntityId: ENT_A, basisPoints: 5000 }, { ownerMemberId: MEM_A2, basisPoints: 5000 }])}`))) === '23514');
  check('NEGATIVE: a user-selected JOINT document with NO allocation is refused', codeOf(await errOf(db, iiDoc('owner_role, owner_selection_source', `'joint', 'user_selected'`))) === '23514');
  // fdh_statement_uploads carries a joint split too (AU investment): same shape rule
  check('a valid joint split on fdh_statement_uploads (6000 + 4000) is accepted', (await errOf(db, up('owner_role, owner_selection_source, owner_allocation', `'joint', 'user_selected', ${alloc(good)}`))) === null);
  check('NEGATIVE: a 9999 joint split on fdh_statement_uploads is refused (chk_fdh_uploads_owner_joint_alloc_0236)', codeOf(await errOf(db, up('owner_role, owner_allocation', `'joint', ${alloc([{ ownerMemberId: MEM_A, basisPoints: 5999 }, { ownerMemberId: MEM_A2, basisPoints: 4000 }])}`))) === '23514');
  check('a bank / liability joint with NO split is still accepted (percentages are not used there)', (await errOf(db, up('owner_role, owner_selection_source', `'joint', 'user_selected'`))) === null);
}

// ---- 4. cross-tenant trigger ------------------------------------------------------
{
  check("NEGATIVE: another user's household member on fdh_statement_uploads is refused", codeOf(await errOf(db, up('owner_member_id, owner_role', `'${MEM_B}', 'self'`))) === '23514');
  check("NEGATIVE: another user's entity on fdh_statement_uploads is refused", codeOf(await errOf(db, up('owner_business_entity_id, owner_role', `'${ENT_B}', 'family_trust'`))) === '23514');
  check("NEGATIVE: another user's household member on ii_source_documents is refused", codeOf(await errOf(db, iiDoc('owner_member_id, owner_role', `'${MEM_B}', 'self'`))) === '23514');
  check("NEGATIVE: another user's entity on ii_source_documents is refused", codeOf(await errOf(db, iiDoc('owner_business_entity_id, owner_role', `'${ENT_B}', 'family_trust'`))) === '23514');
  // UPDATE path too: re-pointing an existing row at someone else's member.
  const e = await errOf(db, `update fdh_statement_uploads set owner_member_id = '${MEM_B}', owner_role = 'self' where user_id = '${A}' and owner_member_id = '${MEM_A}'`);
  check("NEGATIVE: re-pointing an existing upload at another user's member (UPDATE) is refused", codeOf(e) === '23514');
}

// ---- 5. RLS still isolates -------------------------------------------------------
{
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: B, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  const r = await db.query(`select count(*)::int n from fdh_statement_uploads where user_id = '${A}'`);
  const r2 = await db.query(`select count(*)::int n from ii_source_documents where user_id = '${A}'`);
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  check("RLS: user B cannot see user A's uploads or ii documents", r.rows[0].n === 0 && r2.rows[0].n === 0, JSON.stringify([r.rows[0], r2.rows[0]]));
}

// ---- 6. AIE intake owner_selection ----------------------------------------------------
{
  const ins = (v) => `insert into aie_document_intake (user_id, declared_mime_type, byte_size, owner_selection) values ('${A}', 'application/pdf', 10, ${v})`;
  check('aie_document_intake.owner_selection exists after 0236 and accepts a JSON object', (await errOf(db, ins(`'{"kind":"member","member_id":"${MEM_A}"}'::jsonb`))) === null);
  check('an intake with no owner_selection (legacy / insurance) is still valid', (await errOf(db, ins('null'))) === null);
  check('NEGATIVE: a non-object owner_selection is refused (chk_aie_intake_owner_selection_object_0236)', codeOf(await errOf(db, ins(`'"self"'::jsonb`))) === '23514');
  await db.exec(`alter table public.aie_document_intake drop constraint chk_aie_intake_owner_selection_object_0236`);
  check('CONTROL: with the constraint dropped, the same non-object IS accepted (so the constraint is what refused it)', (await errOf(db, ins(`'"self"'::jsonb`))) === null);
  await db.exec(`delete from aie_document_intake where jsonb_typeof(owner_selection) <> 'object'`);
  const re = await errOf(db, target);
  check('re-applying 0236 restores the AIE constraint, and it bites again', re === null && codeOf(await errOf(db, ins(`'"self"'::jsonb`))) === '23514', re?.message);
}

// ---- 7. negative controls on the guards themselves ---------------------------------
// A refusal is only evidence if removing the guard makes the same write succeed.
{
  await db.exec(`drop trigger trg_fdh_statement_uploads_owner_0236 on public.fdh_statement_uploads`);
  const e = await errOf(db, up('owner_member_id, owner_role', `'${MEM_B}', 'self'`));
  check('CONTROL: with the cross-tenant TRIGGER dropped, the same forged member id IS accepted (so the trigger is what refused it)', e === null, e?.message);
  await db.exec(`delete from fdh_statement_uploads where owner_member_id = '${MEM_B}'`);
  await db.exec(`alter table public.ii_source_documents drop constraint chk_ii_source_documents_owner_joint_alloc_0236`);
  const e2 = await errOf(db, iiDoc('owner_role, owner_selection_source, owner_allocation', `'joint', 'user_selected', '${JSON.stringify([{ ownerMemberId: MEM_A, basisPoints: 5999 }, { ownerMemberId: MEM_A2, basisPoints: 4000 }])}'::jsonb`));
  check('CONTROL: with the joint-allocation CONSTRAINT dropped, a 9999 split IS accepted (so the constraint is what refused it)', e2 === null, e2?.message);
  await db.exec(`delete from ii_source_documents where owner_role = 'joint' and owner_allocation is not null and not public.owner_before_upload_allocation_ok(owner_allocation)`);
  // Re-applying 0236 restores both guards (idempotent re-create) -- and they bite again.
  const re = await errOf(db, target);
  check('re-applying 0236 restores the dropped trigger and constraint', re === null, re?.message);
  const again = await errOf(db, up('owner_member_id, owner_role', `'${MEM_B}', 'self'`));
  check('after the restore the forged member id is refused again', codeOf(again) === '23514');
}

// ---- 8. the reviewable BACKFILL script (docs/ownership/...) --------------------------
{
  await db.exec(`delete from fdh_statement_uploads; delete from ii_source_documents;`);
  const acc = (id, role) => `insert into fdh_financial_accounts (id, user_id, account_type, country_code, currency_code, display_name, status${role ? ', owner_role' : ''}) values ('${id}', '${A}', 'transaction', 'AU', 'AUD', 'x', 'active'${role ? `, '${role}'` : ''})`;
  const ACC_SMSF = 'c1111111-1111-4111-8111-111111111111';
  const ACC_NONE = 'c2222222-2222-4222-8222-222222222222';
  const e0 = await errOf(db, acc(ACC_SMSF, 'smsf'));
  const e1 = await errOf(db, acc(ACC_NONE, null));
  check('backfill fixture: accounts seeded', e0 === null && e1 === null, (e0 ?? e1)?.message);
  await db.exec(`insert into fdh_statement_uploads (id, user_id, source_type, document_type, financial_account_id) values
    ('d1111111-1111-4111-8111-111111111111', '${A}', 'csv', 'bank_statement', '${ACC_SMSF}'),
    ('d2222222-2222-4222-8222-222222222222', '${A}', 'csv', 'bank_statement', '${ACC_NONE}'),
    ('d3333333-3333-4333-8333-333333333333', '${A}', 'csv', 'bank_statement', null)`);
  // a user-selected owner must survive the backfill untouched
  await db.exec(`insert into fdh_statement_uploads (id, user_id, source_type, document_type, financial_account_id, owner_role, owner_selection_source) values
    ('d4444444-4444-4444-8444-444444444444', '${A}', 'csv', 'bank_statement', '${ACC_SMSF}', 'joint', 'user_selected')`);
  await db.exec(iiDoc('owner_member_id', `'${MEM_A2}'`));
  await db.exec(iiDoc('', ''));
  const sql = fs.readFileSync(path.join(HERE, '..', 'docs', 'ownership', 'owner_before_upload_phase1_backfill.sql'), 'utf8');
  check('the backfill script ships ending in ROLLBACK (the PO must flip it to COMMIT)', /\nrollback;\s*$/.test(sql));
  const asCommit = sql.replace(/\nrollback;\s*$/, '\ncommit;\n');
  const rolled = await errOf(db, sql);
  check('as shipped (ROLLBACK) the script runs and persists nothing', rolled === null && (await db.query(`select count(*)::int n from fdh_statement_uploads where owner_selection_source = 'backfill_from_account'`)).rows[0].n === 0, rolled?.message);
  const run1 = await errOf(db, asCommit);
  check('the COMMIT variant runs without error', run1 === null, run1?.message);
  const byId = async (id) => (await db.query(`select owner_role, owner_selection_source from fdh_statement_uploads where id = $1`, [id])).rows[0];
  const r1 = await byId('d1111111-1111-4111-8111-111111111111');
  check("bank/liability upload copies the matched account's owner_role (smsf) and says where it came from", r1.owner_role === 'smsf' && r1.owner_selection_source === 'backfill_from_account', JSON.stringify(r1));
  const r2 = await byId('d2222222-2222-4222-8222-222222222222');
  check('an upload whose account has no owner is marked legacy_unset, NOT assigned to anyone', r2.owner_role === null && r2.owner_selection_source === 'legacy_unset', JSON.stringify(r2));
  const r3 = await byId('d3333333-3333-4333-8333-333333333333');
  check('an upload with no account is marked legacy_unset', r3.owner_role === null && r3.owner_selection_source === 'legacy_unset', JSON.stringify(r3));
  const r4 = await byId('d4444444-4444-4444-8444-444444444444');
  check('a user-selected owner is never overwritten by the backfill', r4.owner_role === 'joint' && r4.owner_selection_source === 'user_selected', JSON.stringify(r4));
  const ii = (await db.query(`select owner_member_id, owner_role, owner_selection_source from ii_source_documents order by owner_member_id nulls last`)).rows;
  check("ii document with owner_member_id (a spouse) copies the role 'spouse' from the member", ii[0].owner_role === 'spouse' && ii[0].owner_selection_source === 'backfill_from_document', JSON.stringify(ii[0]));
  check('ii document with no owner_member_id is marked legacy_unset', ii[1].owner_role === null && ii[1].owner_selection_source === 'legacy_unset', JSON.stringify(ii[1]));
  const snap = JSON.stringify((await db.query(`select id, owner_role, owner_selection_source from fdh_statement_uploads order by id`)).rows);
  const run2 = await errOf(db, asCommit);
  const snap2 = JSON.stringify((await db.query(`select id, owner_role, owner_selection_source from fdh_statement_uploads order by id`)).rows);
  check('running the backfill a second time changes nothing (idempotent)', run2 === null && snap === snap2, run2?.message);
  // anti-vacuity for the guard: refuses without 0236's columns is covered by the BEFORE-state check above.
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
