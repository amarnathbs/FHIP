// Clean-rebuild replay: runs the ENTIRE active migration chain from an empty
// database, in filename order, against a real PostgreSQL 18 (PGlite/WASM).
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MIG = process.argv[2] || path.join(REPO, 'supabase/migrations');
const OUT = process.argv[3] || path.join(HERE, 'fresh_manifest.json');

const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'shim.sql'), 'utf8'));
console.log('shim applied');

const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
// Duplicate-version detection (the whole point of the exercise)
const seen = new Map();
for (const f of files) {
  const v = f.slice(0, 4);
  if (seen.has(v)) { console.error(`DUPLICATE VERSION ${v}: ${seen.get(v)} vs ${f}`); process.exit(2); }
  seen.set(v, f);
}
console.log(`${files.length} migrations, ${seen.size} distinct versions, no duplicates`);

// PLATFORM SUBSTITUTION LOG. PGlite (WASM) cannot load C extensions. The only
// two in this repo are pg_cron/pg_net, which create NO project schema objects;
// shim.sql already provides cron.job/cron.schedule/cron.unschedule/net.http_post.
// Every substitution is logged so the certification is auditable.
const subs = [];
function prepare(f, sql) {
  return sql.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, (m, ext) => {
    subs.push(`${f}: "${m.trim()}" -> no-op (shimmed)`);
    return `-- [PLATFORM SUBSTITUTION] ${m.trim()}`;
  });
}

let ok = 0;
for (const f of files) {
  const sql = prepare(f, fs.readFileSync(path.join(MIG, f), 'utf8'));
  try {
    await db.exec(sql);
    ok++;
    process.stdout.write(`  ok ${f}\n`);
    // Project reference-seed convention: supabase/seed.sql supplies the
    // countries/currencies reference rows that later migrations FK against.
    // Applied immediately after 0001 (which creates both tables).
    if (f.startsWith('0001')) {
      await db.exec(fs.readFileSync(path.join(MIG, '..', 'seed.sql'), 'utf8'));
      process.stdout.write('  ok [seed.sql reference data]\n');
    }
  } catch (e) {
    console.error(`\nFAILED at ${f}\n${e.message}\n`);
    process.exit(3);
  }
}
console.log(`\nREPLAY COMPLETE: ${ok}/${files.length} migrations applied with zero manual intervention`);
console.log(`PLATFORM SUBSTITUTIONS (${subs.length}):`);
for (const s of subs) console.log('  - ' + s);

// ---- Deterministic schema fingerprint/manifest ----
const q = async (s) => (await db.query(s)).rows;
const manifest = {};
manifest.tables = await q(`
  select c.relname as table, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' order by 1`);
manifest.columns = await q(`
  select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns where table_schema='public'
  order by table_name, column_name`);
manifest.constraints = await q(`
  select rel.relname as table, con.conname as name, con.contype as type,
         pg_get_constraintdef(con.oid) as def
  from pg_constraint con join pg_class rel on rel.oid=con.conrelid
  join pg_namespace n on n.oid=rel.relnamespace where n.nspname='public'
  order by 1,2`);
manifest.indexes = await q(`
  select tablename as table, indexname as name, indexdef as def
  from pg_indexes where schemaname='public' order by 1,2`);
manifest.policies = await q(`
  select tablename as table, policyname as name, cmd, roles::text, qual, with_check
  from pg_policies where schemaname in ('public','storage') order by 1,2`);
manifest.functions = await q(`
  select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') order by 1,2,3`);
manifest.triggers = await q(`
  select c.relname as table, t.tgname as name
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and not t.tgisinternal order by 1,2`);
manifest.views = await q(`
  select table_name from information_schema.views where table_schema='public' order by 1`);

fs.writeFileSync(OUT, JSON.stringify(manifest, null, 1));
const counts = Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k, v.length]));
console.log('FRESH-REBUILD MANIFEST:', JSON.stringify(counts));
const rls = manifest.tables.filter(t => t.rls).length;
console.log(`tables=${manifest.tables.length} rls_enabled=${rls} rls_disabled=${manifest.tables.length - rls}`);
console.log('ii tables:', manifest.tables.filter(t => t.table.startsWith('ii_')).length);
console.log('resource tables:', manifest.tables.filter(t => t.table.startsWith('resource')).length);
console.log('fdh tables:', manifest.tables.filter(t => t.table.startsWith('fdh_')).length);
console.log('user_financial_section_status present:', manifest.tables.some(t => t.table === 'user_financial_section_status'));
