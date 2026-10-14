// PGlite verification of migration 0276 (one active "self" household member per user) and of its hand-over pack.
// Run: node scripts/owner_before_upload_0276_self_unique_pglite_verification.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const PACK = path.join(ROOT, 'docs', 'ownership', 'po_apply_self_member_unique');
const TARGET = '0276_household_members_one_active_self.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) pass++; else fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`); };
const err = async (db, sql) => { try { await db.exec(sql); return null; } catch (e) { return e; } };

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
for (const f of fs.readdirSync(MIG).filter((x) => x.endsWith('.sql')).sort()) {
  if (f >= TARGET) break;
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
}
console.log('Migration 0276 -- one active self household member per user');
const mig = fs.readFileSync(path.join(MIG, TARGET), 'utf8');
const pack = (f) => fs.readFileSync(path.join(PACK, f), 'utf8');
check('the pack copy of the migration is byte-identical to the shipped migration', pack('02_apply_0276_one_active_self.sql') === mig);

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users(id, email) values ('${A}', 'a@t.test'), ('${B}', 'b@t.test') on conflict do nothing`);
await db.exec(`update user_profiles set country_of_residence='IN', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id in ('${A}','${B}')`);
const ins = (user, rel, extra = '') => `insert into household_members (user_id, full_name, relationship${extra ? ', ' + extra.split('|')[0] : ''}) values ('${user}', 'P ${Math.random()}', '${rel}'${extra ? ', ' + extra.split('|')[1] : ''})`;
const detect = async () => (await db.query(pack('00_detect_duplicate_self_members.sql'))).rows;

// ---- BEFORE the index: the defect state exists and the detection query finds it
await db.exec(ins(A, 'self'));
await db.exec(ins(A, 'self'));
await db.exec(ins(B, 'self'));
const found = await detect();
check('BEFORE 0276 two active self rows can exist (the race defect) and file 00 lists exactly that user, ids cut to 8 characters', found.length === 1 && found[0].user8 === A.slice(0, 8) && Number(found[0].active_self_rows) === 2 && found[0].ids8.split(' ').every((x) => x.length === 8), JSON.stringify(found));
const refs = (await db.query(pack('01_references_of_duplicate_rows.sql'))).rows;
check('file 01 runs and marks the oldest row KEEP and the other extra, with reference counts', refs.length === 2 && refs.filter((r) => r.role_of_row.startsWith('KEEP')).length === 1 && refs.every((r) => Number(r.ii_accounts) === 0), JSON.stringify(refs.map((r) => [r.role_of_row, r.ii_accounts])));

// ---- the guard refuses, changes nothing
const before = JSON.stringify((await db.query(`select id, is_active from household_members order by id`)).rows);
const refused = await err(db, mig);
check('GUARD: the migration REFUSES (clear message) while a duplicate exists', refused !== null && /0276 refused/.test(refused.message) && /more than one active self/.test(refused.message), refused?.message?.slice(0, 120));
check('GUARD: it changed nothing (no row touched, no index created)', JSON.stringify((await db.query(`select id, is_active from household_members order by id`)).rows) === before && (await db.query(`select 1 from pg_indexes where indexname='uq_household_members_one_active_self'`)).rows.length === 0);

// ---- fix the duplicate the documented way (deactivate the newest, keep the oldest), then apply
await db.exec(`update household_members set is_active = false where id = (select id from household_members where user_id='${A}' and relationship='self' order by created_at desc, id desc limit 1)`);
check('after deactivating the extra row file 00 is empty', (await detect()).length === 0);
check('the migration now applies', (await err(db, mig)) === null);
check('file 03 shows the index and the household sizes', (await db.query(pack('03_verify_index_and_household_sizes.sql'))).rows.some((r) => r.what === 'index' && /UNIQUE/i.test(r.detail) && /is_active/.test(r.detail)));
check('the migration applies a SECOND time (idempotent)', (await err(db, mig)) === null);

// ---- behaviour
check('NEGATIVE: a second ACTIVE self row for the same user is refused (unique violation 23505)', (await err(db, ins(A, 'self')))?.code === '23505');
await db.exec(`drop index uq_household_members_one_active_self`);
check('CONTROL: with the index dropped the same insert IS accepted, so the index is what refused it', (await err(db, ins(A, 'self'))) === null);
await db.exec(`delete from household_members where user_id='${A}' and relationship='self' and is_active and id <> (select id from household_members where user_id='${A}' and relationship='self' and is_active order by created_at, id limit 1)`);
await db.exec(mig);
check('re-applying restores the index and it bites again', (await err(db, ins(A, 'self')))?.code === '23505');

// household size is unlimited: self + spouse + 3 children + parent + other_dependant + other = 8
for (const rel of ['spouse', 'child', 'child', 'child', 'parent', 'other_dependant', 'other', 'partner']) await db.exec(ins(A, rel));
const size = (await db.query(`select count(*)::int n from household_members where user_id='${A}' and is_active`)).rows[0].n;
check('HOUSEHOLD SIZE IS NOT LIMITED: self + spouse + 3 children + parent + dependant + other + partner (9 active members) are all accepted', size === 9, `active members=${size}`);
for (let i = 0; i < 12; i++) await db.exec(ins(A, 'child'));
check('twelve more children are accepted as well (21 active members): no cap of any kind', (await db.query(`select count(*)::int n from household_members where user_id='${A}' and is_active`)).rows[0].n === 21);
check('two spouses / partners are not restricted either (only self is)', (await err(db, ins(A, 'spouse'))) === null && (await err(db, ins(A, 'partner'))) === null);

// removed rows follow the real semantics: is_active=false is outside the index
await db.exec(`update household_members set is_active=false where user_id='${A}' and relationship='self'`);
check('an inactive (removed) self row sits outside the rule: a NEW active self can then be added', (await err(db, ins(A, 'self'))) === null);
await db.exec(`update household_members set is_active=false where user_id='${A}' and relationship='self' and is_active`);
check('many inactive self rows are allowed (removed rows are not restricted)', (await err(db, ins(A, 'self', 'is_active|false'))) === null && (await err(db, ins(A, 'self', 'is_active|false'))) === null);
await db.exec(ins(A, 'self'));
const inactiveId = (await db.query(`select id from household_members where user_id='${A}' and relationship='self' and not is_active limit 1`)).rows[0].id;
check('NEGATIVE: re-activating an inactive self while another active self exists is refused', (await err(db, `update household_members set is_active=true where id='${inactiveId}'`))?.code === '23505');
check('another user is unaffected: user B has its own single self, and a second one for B is refused', (await err(db, ins(B, 'self')))?.code === '23505' && (await db.query(`select count(*)::int n from household_members where user_id='${B}' and relationship='self' and is_active`)).rows[0].n === 1);
await db.exec(ins(B, 'spouse'));
check('changing a spouse row to self while an active self exists is refused (the rule covers updates)', (await err(db, `update household_members set relationship='self' where id=(select id from household_members where user_id='${B}' and relationship='spouse' limit 1)`))?.code === '23505');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
