// Proves three things with a real PostgreSQL 18 (PGlite):
//  A. ORDER-EQUIVALENCE: replaying the ORIGINAL historical order
//     (0001-0030 + archived Phase0C/Resources 0031-0040) yields the same
//     Phase0C+Resources schema as the reconciled chain (0001-0048 + 0049).
//  B. IDEMPOTENCY: applying 0049 a second time changes nothing.
//  C. NEGATIVE CONTROL: the comparison can actually detect a difference.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'supabase');
const MIG = path.join(ROOT, 'migrations'), ARCH = path.join(ROOT, 'migration_archive');
const shim = fs.readFileSync(path.join(HERE, 'shim.sql'), 'utf8');
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');

async function build(list, label) {
  const db = await PGlite.create();
  await db.exec(shim);
  for (const p of list) {
    await db.exec(strip(fs.readFileSync(p, 'utf8')));
    if (path.basename(p).startsWith('0001')) await db.exec(seed);
  }
  console.log(`built: ${label} (${list.length} files)`);
  return db;
}

// Scope of comparison: only the objects this reconciliation is responsible for.
const SCOPE = `(table_name like 'resource%' or table_name = 'user_financial_section_status')`;
async function manifest(db) {
  const q = async (s) => (await db.query(s)).rows;
  return {
    columns: await q(`select table_name, column_name, data_type, is_nullable, coalesce(column_default,'') d
      from information_schema.columns where table_schema='public' and ${SCOPE} order by 1,2`),
    constraints: await q(`select rel.relname t, con.conname n, pg_get_constraintdef(con.oid) def
      from pg_constraint con join pg_class rel on rel.oid=con.conrelid
      join pg_namespace ns on ns.oid=rel.relnamespace where ns.nspname='public'
      and (rel.relname like 'resource%' or rel.relname='user_financial_section_status') order by 1,2,3`),
    indexes: await q(`select tablename t, indexname n, indexdef def from pg_indexes where schemaname='public'
      and (tablename like 'resource%' or tablename='user_financial_section_status') order by 1,2`),
    policies: await q(`select tablename t, policyname n, cmd, roles::text r, coalesce(qual,'') q, coalesce(with_check,'') w
      from pg_policies where schemaname='public'
      and (tablename like 'resource%' or tablename='user_financial_section_status') order by 1,2`),
    rls: await q(`select c.relname t, c.relrowsecurity rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and (c.relname like 'resource%' or c.relname='user_financial_section_status') order by 1`),
    functions: await q(`select n.nspname s, p.proname n, pg_get_function_identity_arguments(p.oid) a, md5(p.prosrc) src
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private','public')
      and (p.proname like '%resource%' or p.proname like '%section%') order by 1,2,3`),
  };
}
const cmp = (a, b, label) => {
  let diffs = 0;
  for (const k of Object.keys(a)) {
    const A = JSON.stringify(a[k]), B = JSON.stringify(b[k]);
    if (A === B) { console.log(`   ${label} ${k.padEnd(12)} IDENTICAL (${a[k].length} rows)`); }
    else {
      diffs++;
      console.log(`   ${label} ${k.padEnd(12)} *** DIFFERENT *** (${a[k].length} vs ${b[k].length})`);
      const as = new Set(a[k].map(x => JSON.stringify(x))), bs = new Set(b[k].map(x => JSON.stringify(x)));
      for (const x of a[k].map(x => JSON.stringify(x))) if (!bs.has(x)) console.log('      only-in-A: ' + x.slice(0, 220));
      for (const x of b[k].map(x => JSON.stringify(x))) if (!as.has(x)) console.log('      only-in-B: ' + x.slice(0, 220));
    }
  }
  return diffs;
};

const sorted = (d) => fs.readdirSync(d).filter(f => f.endsWith('.sql')).sort().map(f => path.join(d, f));
const active = sorted(MIG);
const base = active.filter(f => path.basename(f) < '0031');
const historical = [...base, ...sorted(ARCH)];

console.log('\n=== A. ORDER-EQUIVALENCE ===');
const dbNew = await build(active, 'RECONCILED chain 0001-0048 + 0049');
const dbOld = await build(historical, 'HISTORICAL order 0001-0030 + archived 0031-0040');
const mNew = await manifest(dbNew), mOld = await manifest(dbOld);
const dA = cmp(mOld, mNew, '  [A]');
console.log(dA === 0 ? '   RESULT: PASS - schemas are byte-identical' : `   RESULT: FAIL - ${dA} differing categories`);

console.log('\n=== C. NEGATIVE CONTROL (comparison must be able to fail) ===');
await dbOld.exec(`alter table resource_posts add column zz_negative_control text;
  drop policy if exists "public read active tags" on resource_tags;`);
const mCtl = await manifest(dbOld);
const dC = cmp(mCtl, mNew, '  [C]');
console.log(dC > 0 ? `   RESULT: PASS - control detected ${dC} differing categories (comparison is meaningful)`
                   : '   RESULT: FAIL - control change went undetected; comparison is vacuous');

console.log('\n=== B. IDEMPOTENCY (0049 applied a second time) ===');
const before = await manifest(dbNew);
await dbNew.exec(strip(fs.readFileSync(path.join(MIG, '0049_reconcile_phase0c_resources_lineage.sql'), 'utf8')));
console.log('   second application of 0049 completed without error');
const after = await manifest(dbNew);
const dB = cmp(before, after, '  [B]');
console.log(dB === 0 ? '   RESULT: PASS - re-application is a true no-op' : `   RESULT: FAIL - ${dB} categories changed`);

console.log(`\nSUMMARY  order-equivalence=${dA === 0 ? 'PASS' : 'FAIL'}  negative-control=${dC > 0 ? 'PASS' : 'FAIL'}  idempotency=${dB === 0 ? 'PASS' : 'FAIL'}`);
