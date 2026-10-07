// NAV2 migrations 0260 (parts a-e, or the whole file), 0261, 0262, 0263: the EXPECTED database shape, proven in an in-process Postgres
// (PGlite) from empty, from partial and from complete state and on re-run, and a READ-ONLY comparison with DEV.
//
//   node scripts/nav2_schema_inventory.mjs prove                 replay the chain, apply in four ways, prove identical, write expected_inventory.json
//   node scripts/nav2_schema_inventory.mjs sql                   print the one read-only catalog query (paste it in the Supabase SQL editor)
//   node scripts/nav2_schema_inventory.mjs compare <actual.json> compare the JSON that query returned on DEV with the expected inventory
//   node scripts/nav2_schema_inventory.mjs dev-openapi           read-only, no SQL access needed: compares tables, columns, nullability and
//                                                                functions with what DEV's REST interface reports. Aborts unless the host is
//                                                                the DEV project (vqycarelcoijzwlpkpcz); never prints a key.
//
// The expected inventory is derived by RUNNING the migrations (never from a hand list): every table, column (type, nullability, default),
// constraint (full definition), index, row-level-security flag and policy, table grant, trigger and function (identity arguments, security
// mode, volatility, result type, execute grants, body hash and a comment-and-whitespace-insensitive body hash). A bare "create table if
// not exists" proves nothing about an existing table, so the comparison is on the real columns and constraints, not on names.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MIG = path.join(REPO, 'supabase', 'migrations');
const PARTS = path.join(REPO, 'docs', 'nav2', 'po_apply_0260_0262', 'parts');
const OUT_DIR = path.join(REPO, 'docs', 'nav2', 'dev_inventory');
const DEV_REF = 'vqycarelcoijzwlpkpcz';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const F = (p) => files.find((f) => f.startsWith(p));
const NAV2_FILES = [F('0260_'), F('0261_'), F('0262_'), F('0263_')];
const partFiles = ['a', 'b', 'c', 'd', 'e'].map((l) => path.join(PARTS, `0260${l}.sql`));
const read = (f) => strip(fs.readFileSync(f, 'utf8'));

// ---- the names, taken from the migration text itself ----------------------------------------------------------------------------
const nav2Text = NAV2_FILES.map((f) => fs.readFileSync(path.join(MIG, f), 'utf8')).join('\n');
const TABLES = [...new Set([...nav2Text.matchAll(/create table if not exists (\w+)/gi)].map((m) => m[1]))].sort();
const FUNCTIONS = [...new Set([...nav2Text.matchAll(/create or replace function (\w+)/gi)].map((m) => m[1]))].sort();
const ADMIN_COLUMNS = [...new Set([...nav2Text.matchAll(/add column if not exists (can_\w+)/gi)].map((m) => m[1]))].sort();
const JOB_KEYS = [...new Set([...nav2Text.matchAll(/'(nav2_[a-z_]+)'/g)].map((m) => m[1]))].filter((k) => /weekly_refresh|fund_analytics$|trigger_planner|correction_worker/.test(k)).sort();
const q = (list) => list.map((x) => `'${x}'`).join(', ');

export function catalogSql() {
  return `select jsonb_build_object(
  'columns', (select coalesce(jsonb_agg(jsonb_build_array(c.table_name, c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, ''), coalesce(c.character_maximum_length, 0), coalesce(c.numeric_precision, 0), coalesce(c.numeric_scale, 0), c.is_identity) order by c.table_name, c.column_name), '[]'::jsonb)
      from information_schema.columns c where c.table_schema = 'public' and (c.table_name in (${q(TABLES)}) or (c.table_name = 'admin_users' and c.column_name in (${q(ADMIN_COLUMNS)})))),
  'constraints', (select coalesce(jsonb_agg(jsonb_build_array(cl.relname, k.conname, k.contype::text, pg_get_constraintdef(k.oid)) order by cl.relname, k.conname), '[]'::jsonb)
      from pg_constraint k join pg_class cl on cl.oid = k.conrelid join pg_namespace n on n.oid = cl.relnamespace where n.nspname = 'public' and cl.relname in (${q(TABLES)})),
  'indexes', (select coalesce(jsonb_agg(jsonb_build_array(i.tablename, i.indexname, i.indexdef) order by i.tablename, i.indexname), '[]'::jsonb)
      from pg_indexes i where i.schemaname = 'public' and i.tablename in (${q(TABLES)})),
  'rls', (select coalesce(jsonb_agg(jsonb_build_array(cl.relname, cl.relrowsecurity) order by cl.relname), '[]'::jsonb)
      from pg_class cl join pg_namespace n on n.oid = cl.relnamespace where n.nspname = 'public' and cl.relname in (${q(TABLES)})),
  'policies', (select coalesce(jsonb_agg(jsonb_build_array(p.tablename, p.policyname, p.cmd, p.roles::text, coalesce(p.qual, ''), coalesce(p.with_check, '')) order by p.tablename, p.policyname), '[]'::jsonb)
      from pg_policies p where p.schemaname = 'public' and p.tablename in (${q(TABLES)})),
  'grants', (select coalesce(jsonb_agg(jsonb_build_array(g.table_name, g.grantee, g.privilege_type) order by g.table_name, g.grantee, g.privilege_type), '[]'::jsonb)
      from (select distinct table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated') and table_name in (${q(TABLES)})) g),
  'triggers', (select coalesce(jsonb_agg(jsonb_build_array(cl.relname, t.tgname, pg_get_triggerdef(t.oid)) order by cl.relname, t.tgname), '[]'::jsonb)
      from pg_trigger t join pg_class cl on cl.oid = t.tgrelid join pg_namespace n on n.oid = cl.relnamespace where n.nspname = 'public' and not t.tgisinternal and (cl.relname in (${q(TABLES)}) or cl.relname in ('ii_reference_corrections', 'ii_risk_free_corrections'))),
  'functions', (select coalesce(jsonb_agg(jsonb_build_array(pr.proname, pg_get_function_identity_arguments(pr.oid), pg_get_function_result(pr.oid), pr.prosecdef, pr.provolatile::text,
        md5(pr.prosrc), md5(lower(regexp_replace(regexp_replace(pr.prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g'))),
        has_function_privilege('anon', pr.oid, 'execute'), has_function_privilege('authenticated', pr.oid, 'execute'), has_function_privilege('service_role', pr.oid, 'execute')) order by pr.proname, pg_get_function_identity_arguments(pr.oid)), '[]'::jsonb)
      from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = 'public' and pr.proname in (${q(FUNCTIONS)})),
  'job_keys', (select coalesce(jsonb_agg(jsonb_build_array(j.job_key, j.enabled) order by j.job_key), '[]'::jsonb) from ii_reference_job_control j where j.job_key in (${q(JOB_KEYS)})),
  'series_seed', (select coalesce(jsonb_agg(jsonb_build_array(s.series_id, s.role, s.cadence, s.max_staleness_days, s.terms_review_status) order by s.series_id), '[]'::jsonb) from ii_risk_free_series s)
) as inventory`;
}

const SECTIONS = ['columns', 'constraints', 'indexes', 'rls', 'policies', 'grants', 'triggers', 'functions', 'job_keys', 'series_seed'];
// For the functions section the exact body hash (index 5) is informational: a hand-patched copy may differ in comments only. The comparison
// uses the comment- and whitespace-insensitive hash (index 6) and reports an exact-text difference separately.
const keyOf = (section, row) => (section === 'functions' ? `${row[0]}(${row[1]})` : section === 'columns' ? `${row[0]}.${row[1]}` : section === 'job_keys' || section === 'series_seed' ? row[0] : JSON.stringify(row.slice(0, 2)));

export function diffInventories(expected, actual) {
  const out = { missing: [], extra: [], different: [], textOnly: [] };
  for (const s of SECTIONS) {
    const e = new Map((expected[s] ?? []).map((r) => [keyOf(s, r), r]));
    const a = new Map((actual[s] ?? []).map((r) => [keyOf(s, r), r]));
    for (const [k, r] of e) {
      if (!a.has(k)) out.missing.push(`${s}: ${k}`);
      else {
        const x = a.get(k);
        if (s === 'job_keys') continue; // state, not shape: only its presence is compared
        if (s === 'series_seed') {
          if (JSON.stringify([r[1], r[2], r[3]]) !== JSON.stringify([x[1], x[2], x[3]])) out.different.push(`${s}: ${k}\n    expected ${JSON.stringify(r)}\n    actual   ${JSON.stringify(x)}`);
          continue;
        }
        if (s === 'functions') {
          const same = JSON.stringify([r[0], r[1], r[2], r[3], r[4], r[6], r[7], r[8], r[9]]) === JSON.stringify([x[0], x[1], x[2], x[3], x[4], x[6], x[7], x[8], x[9]]);
          if (!same) out.different.push(`${s}: ${k}\n    expected ${JSON.stringify(r.filter((_, i) => i !== 5))}\n    actual   ${JSON.stringify(x.filter((_, i) => i !== 5))}`);
          else if (r[5] !== x[5]) out.textOnly.push(`${s}: ${k} (body differs only in comments / whitespace)`);
          continue;
        }
        if (JSON.stringify(r) !== JSON.stringify(x)) out.different.push(`${s}: ${k}\n    expected ${JSON.stringify(r)}\n    actual   ${JSON.stringify(x)}`);
      }
    }
    for (const k of a.keys()) if (!e.has(k)) out.extra.push(`${s}: ${k}`);
  }
  return out;
}

async function freshDb() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  for (const f of files.filter((x) => x < NAV2_FILES[0])) {
    await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(REPO, 'supabase', 'seed.sql'), 'utf8'));
  }
  return db;
}
const inventoryOf = async (db) => (await db.query(catalogSql())).rows[0].inventory;
const applyParts = async (db, list = partFiles) => { for (const f of list) await db.exec(read(f)); };
const applyRest = async (db) => { for (const f of NAV2_FILES.slice(1)) await db.exec(read(path.join(MIG, f))); };
const hash = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);

async function prove() {
  const results = [];
  const run = async (label, fn) => {
    const db = await freshDb();
    let rerun = null;
    const t0 = Date.now();
    await fn(db, (e) => { rerun = e; });
    const inv = await inventoryOf(db);
    results.push({ label, inv, rerun, secs: Math.round((Date.now() - t0) / 1000) });
    console.log(`  ${label}: ${SECTIONS.map((s) => `${s} ${inv[s].length}`).join(', ')}  (${hash(inv)})${rerun ? `  RERUN ERROR: ${rerun}` : ''}`);
    await db.close();
  };
  console.log(`tables ${TABLES.length}, functions ${FUNCTIONS.length}, admin columns ${ADMIN_COLUMNS.join(', ')}, job keys ${JOB_KEYS.join(', ')}`);
  await run('1. from EMPTY, 0260 as five parts, then 0261, 0262, 0263 (the hand-run order)', async (db) => { await applyParts(db); await applyRest(db); });
  await run('2. from EMPTY, 0260 as the whole file, then 0261, 0262, 0263 (the supabase CLI order)', async (db) => { await db.exec(read(path.join(MIG, NAV2_FILES[0]))); await applyRest(db); });
  await run('3. from PARTIAL (part a alone, the half-applied shape), then every part, then 0261-0263', async (db) => { await applyParts(db, partFiles.slice(0, 1)); await applyParts(db); await applyRest(db); });
  await run('4. from COMPLETE, every file applied a SECOND time (re-run)', async (db, setErr) => {
    await applyParts(db); await applyRest(db);
    try { await applyParts(db); await applyRest(db); await db.exec(read(path.join(MIG, NAV2_FILES[0]))); } catch (e) { setErr(e.message); }
  });
  const base = hash(results[0].inv);
  const same = results.every((r) => hash(r.inv) === base);
  const noErr = results.every((r) => r.rerun === null);
  console.log(`\nidentical inventory in all four states: ${same ? 'YES' : 'NO'}; second apply raised no error: ${noErr ? 'YES' : 'NO'}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'expected_inventory.json'), JSON.stringify(results[0].inv, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'nav2_catalog_inventory.sql'), `-- Read-only. Paste into the Supabase SQL editor of the DEV project and run it. It returns ONE jsonb value named inventory.\n-- Save that value as actual.json and run:  node scripts/nav2_schema_inventory.mjs compare actual.json\n${catalogSql()};\n`);
  console.log(`wrote ${path.relative(REPO, path.join(OUT_DIR, 'expected_inventory.json'))} and nav2_catalog_inventory.sql`);
  if (!same || !noErr) process.exit(1);
}

function loadDevEnv() {
  const file = path.join(REPO, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes(DEV_REF)) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not the DEV project: aborting');
  if (Object.keys(env).some((k) => k.startsWith('PRODUCTION_'))) throw new Error('a PRODUCTION_ variable is present in this .env.local: aborting');
  return env;
}

async function devOpenApi() {
  const env = loadDevEnv();
  const expected = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'expected_inventory.json'), 'utf8'));
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Accept: 'application/openapi+json' } });
  if (!res.ok) throw new Error(`the REST interface answered ${res.status}`);
  const api = await res.json();
  const defs = api.definitions ?? {};
  const paths = Object.keys(api.paths ?? {});
  const problems = [];
  let colsChecked = 0;
  const byTable = new Map();
  for (const r of expected.columns) byTable.set(r[0], [...(byTable.get(r[0]) ?? []), r]);
  for (const [table, cols] of byTable) {
    const d = defs[table];
    if (!d) { problems.push(`table ${table}: not exposed by DEV`); continue; }
    const props = d.properties ?? {};
    const required = new Set(d.required ?? []);
    for (const c of cols) {
      colsChecked += 1;
      const [, name, dataType, nullable, dflt, , , , identity] = c;
      if (!(name in props)) { problems.push(`column ${table}.${name}: missing on DEV`); continue; }
      // PostgREST lists every NOT NULL column as required, whether or not it has a default.
      const mustBeRequired = nullable === 'NO';
      void dflt; void identity;
      if (mustBeRequired !== required.has(name)) problems.push(`column ${table}.${name}: nullability differs (expected ${mustBeRequired ? 'required' : 'optional'}, DEV ${required.has(name) ? 'required' : 'optional'})`);
      const fmt = String(props[name].format ?? props[name].type ?? '');
      const want = { uuid: 'uuid', text: 'text', date: 'date', boolean: 'boolean', integer: 'integer', bigint: 'bigint', jsonb: 'jsonb', numeric: 'numeric', 'timestamp with time zone': 'timestamp with time zone', ARRAY: 'text[]' }[dataType] ?? dataType;
      if (!fmt.startsWith(want) && !(want === 'text' && fmt === 'character varying') && !(want === 'text[]' && /\[\]|array/i.test(fmt))) problems.push(`column ${table}.${name}: type differs (expected ${want}, DEV ${fmt})`);
    }
    const expectedNames = new Set(cols.map((c) => c[1]));
    for (const p of Object.keys(props)) if (table !== 'admin_users' && !expectedNames.has(p)) problems.push(`column ${table}.${p}: present on DEV but not expected`);
  }
  let fnChecked = 0;
  for (const fn of FUNCTIONS) {
    const isRpc = paths.includes(`/rpc/${fn}`);
    const exposed = expected.functions.some((r) => r[0] === fn && (r[8] || r[9]));
    if (/_guard|append_only|immutable|capture_|^is_risk|nav2_monitor_cell|pc6_nav_row|obs_guard/.test(fn) && !isRpc) continue; // trigger functions and helpers are not exposed as RPC
    fnChecked += 1;
    if (exposed && !isRpc) problems.push(`function ${fn}: expected to be callable (RPC), not exposed on DEV`);
  }
  console.log(`DEV (${DEV_REF}) read-only REST comparison: ${byTable.size} tables, ${colsChecked} columns, ${fnChecked} functions checked`);
  if (problems.length === 0) console.log('EXACT MATCH on table presence, column names, nullability, coarse types, and the callable functions.');
  else { console.log(`${problems.length} DIFFERENCE(S):`); for (const p of problems) console.log(`  - ${p}`); }
  console.log('Not covered by this mode (the REST interface does not report them): constraints, indexes, policies, grants, triggers, function bodies. Run the catalog query for those.');
  if (problems.length) process.exit(1);
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'prove') await prove();
else if (mode === 'sql') console.log(catalogSql() + ';');
else if (mode === 'compare') {
  const expected = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'expected_inventory.json'), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(path.resolve(arg), 'utf8'));
  const actual = raw.inventory ?? raw;
  const d = diffInventories(expected, actual);
  console.log(`missing ${d.missing.length}, extra ${d.extra.length}, different ${d.different.length}, comment-only function differences ${d.textOnly.length}`);
  for (const k of ['missing', 'extra', 'different', 'textOnly']) for (const x of d[k]) console.log(`  [${k}] ${x}`);
  if (d.missing.length || d.extra.length || d.different.length) process.exit(1);
  console.log('EXACT MATCH (shape). Function bodies equal ignoring comments and whitespace.');
} else if (mode === 'dev-openapi') await devOpenApi();
else {
  console.log('usage: node scripts/nav2_schema_inventory.mjs prove | sql | compare <actual.json> | dev-openapi');
  process.exit(2);
}
