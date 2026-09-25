// NAV 1 completion (2026-09-25) -- PGlite verification for migration 0201
// (partial indexes on ii_prices_nav's self-referencing foreign keys).
//
// Negative control first: before 0201, the query Postgres runs to check the
// foreign key when a row is deleted ("any row whose superseded_by_id /
// correction_of_id = this id?") has no index to use -- EXPLAIN shows a
// sequential scan. After 0201 it uses the new partial index. Also: the FK
// still blocks deleting a referenced row, deletes of unreferenced rows work,
// and a re-apply is a no-op.
//
// Run: node scripts/nav1_0201_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0201_nav1_prices_nav_self_fk_indexes.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
for (const f of files.filter((x) => x < TARGET)) {
  await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
  if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
}

let pass = 0, fail = 0, seq = 0;
const check = (label, cond, detail = '') => {
  seq++;
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  NAV1-0201-${String(seq).padStart(2, '0')}  ${label}${detail ? '\n        ' + detail : ''}`);
};
const err = async (sql) => { try { await db.query(sql); return null; } catch (e) { return e.message; } };

// 20,000 NAV rows for one instrument; two of them are corrections of two others.
const INST = '55550000-0000-0000-0000-000000000201';
await db.exec(`insert into ii_instruments (id, instrument_name, instrument_class, country_of_domicile, base_currency, status) values ('${INST}','0201 probe','mutual_fund','IN','INR','verified')`);
await db.exec(`insert into ii_prices_nav (instrument_id, currency_code, price_date, price, quality_status)
  select '${INST}', 'INR', date '1970-01-01' + g, 10 + g / 1000.0, 'ok' from generate_series(1, 20000) g`);
const ids = (await db.query(`select id from ii_prices_nav where instrument_id='${INST}' order by price_date limit 4`)).rows.map((r) => r.id);
await db.exec(`update ii_prices_nav set superseded_by_id='${ids[1]}' where id='${ids[0]}'`);
await db.exec(`update ii_prices_nav set correction_of_id='${ids[3]}' where id='${ids[2]}'`);
await db.exec('analyze ii_prices_nav');

// The query shape Postgres' RI trigger issues for ON DELETE NO ACTION.
const plan = async (col) => (await db.query(`explain select 1 from only ii_prices_nav x where ${col} = '${ids[1]}'::uuid for key share of x`)).rows.map((r) => r['QUERY PLAN']).join(' | ');

const s0 = await plan('superseded_by_id');
const c0 = await plan('correction_of_id');
check('NEGATIVE CONTROL: before 0201, the superseded_by_id FK check is a SEQUENTIAL scan', /Seq Scan/.test(s0) && !/Index/.test(s0), s0);
check('NEGATIVE CONTROL: before 0201, the correction_of_id FK check is a SEQUENTIAL scan', /Seq Scan/.test(c0) && !/Index/.test(c0), c0);

await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8')));
let reapply = null; try { await db.exec(strip(fs.readFileSync(path.join(MIG, TARGET), "utf8"))); } catch (e) { reapply = e.message; }
check('0201 applies; a second apply is a no-op', reapply === null, reapply ?? '');
await db.exec('analyze ii_prices_nav');

const s1 = await plan('superseded_by_id');
const c1 = await plan('correction_of_id');
check('after 0201 the superseded_by_id FK check uses idx_ii_prices_nav_superseded_by_id', /idx_ii_prices_nav_superseded_by_id/.test(s1), s1);
check('after 0201 the correction_of_id FK check uses idx_ii_prices_nav_correction_of_id', /idx_ii_prices_nav_correction_of_id/.test(c1), c1);
const sizes = (await db.query(`select indexrelname, (select count(*) from ii_prices_nav where superseded_by_id is not null)::int s, (select count(*) from ii_prices_nav where correction_of_id is not null)::int c from pg_stat_user_indexes where indexrelname like 'idx_ii_prices_nav_%_id'`)).rows;
check('the indexes are partial (only set values are indexed)', (await db.query(`select count(*)::int n from pg_indexes where indexname in ('idx_ii_prices_nav_superseded_by_id','idx_ii_prices_nav_correction_of_id') and indexdef ilike '%where%is not null%'`)).rows[0].n === 2, JSON.stringify(sizes));

const blocked = await err(`delete from ii_prices_nav where id = '${ids[1]}'`);
check('the FK still blocks deleting a row another row supersedes (the constraint is unchanged)', blocked !== null && /foreign key/i.test(blocked), blocked ?? 'deleted!');
const ok = await err(`delete from ii_prices_nav where instrument_id='${INST}' and price_date > date '1970-01-01' + 100`);
check('deleting unreferenced rows works', ok === null, ok ?? '');

console.log(`\n=== NAV 1 / 0201 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
