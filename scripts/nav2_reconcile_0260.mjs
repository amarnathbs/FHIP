// NAV2 production partial state: parts a, b and c of migration 0260 are on production (found by the production pre-check P1 on 17-10-2026), parts d and e and
// everything after are not. A bare "create table if not exists" proves nothing about the shape of a table that is already there, so this tool builds a READ-ONLY
// reconciliation query for the Product Owner that compares the shape of every pre-existing object with what 0260 parts a to c create, and tells exactly which
// aspect differs.
//
//   node scripts/nav2_reconcile_0260.mjs generate     replays parts a to c in an in-process Postgres (PGlite), computes the expected fingerprint of every aspect with the
//                                                      SAME query that will run on production, writes the two SQL files under docs/nav2/po_apply_production/sql/prechecks/
//                                                      and the readable expected text under docs/nav2/po_apply_production/inventory/expected_0260_abc_fingerprints.json
//   node scripts/nav2_reconcile_0260.mjs compare <actual.json>   compares the jsonb that nav2_catalog_inventory.sql returned on production with the expected inventory,
//                                                      restricted to the objects of 0260 parts a to c (the objects of parts d and e and of 0261 onward are reported as expected-absent)
//
// What is compared, per table: columns (name, type, nullability, default, length, precision), constraints (name and full definition), indexes (name and definition),
// row level security flag, policies, grants to anon and authenticated, triggers; per function: arguments, result type, security mode, volatility, fixed settings, body
// (comment and white space insensitive md5), execute rights of anon, authenticated and service role; for the two seed rows: every field. Objects of parts d and e must be ABSENT.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PACK = path.join(REPO, 'docs', 'nav2', 'po_apply_production');
const PARTS = path.join(PACK, 'sql', 'parts');
const PRE = path.join(PACK, 'sql', 'prechecks');
const INV = path.join(PACK, 'inventory');

export const TABLES = ['ii_risk_free_series', 'ii_risk_free_batches', 'ii_risk_free_observations', 'ii_risk_free_review_items', 'ii_risk_free_corrections', 'ii_risk_free_series_state_log'];
export const FUNCTIONS = ['is_risk_free_data_admin', 'is_risk_free_series_switch_admin', 'ii_risk_free_append_only', 'ii_risk_free_obs_guard'];
export const ABSENT_FUNCTIONS = ['commit_risk_free_upload', 'record_risk_free_refresh_results', 'resolve_risk_free_review_item', 'correct_risk_free_observation', 'set_risk_free_series_state'];
const ADMIN_COLUMNS = ['can_upload_risk_free_data', 'can_switch_risk_free_series'];
const q = (l) => l.map((x) => `'${x}'`).join(', ');

/** The fingerprint query: one row per (object, aspect) with the full readable text of what the database holds. Same text runs in PGlite and on production. */
export function fingerprintSelect() {
  return `select object, aspect, replace(actual, 'public.', '') as actual from (
  select c.table_name::text as object, 'columns'::text as aspect,
    string_agg(c.column_name || ' / ' || c.data_type || ' / ' || c.is_nullable || ' / ' || coalesce(c.column_default, 'none') || ' / ' || coalesce(c.character_maximum_length, 0)::text || ' / ' || coalesce(c.numeric_precision, 0)::text || ' / ' || coalesce(c.numeric_scale, 0)::text, ' , ' order by c.column_name) as actual
  from information_schema.columns c where c.table_schema = 'public' and c.table_name in (${q(TABLES)}) group by c.table_name
  union all
  select 'admin_users', 'columns', string_agg(c.column_name || ' / ' || c.data_type || ' / ' || c.is_nullable || ' / ' || coalesce(c.column_default, 'none'), ' , ' order by c.column_name)
  from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'admin_users' and c.column_name in (${q(ADMIN_COLUMNS)})
  union all
  select cl.relname, 'constraints', string_agg(k.conname || ' = ' || pg_get_constraintdef(k.oid), ' , ' order by k.conname)
  from pg_constraint k join pg_class cl on cl.oid = k.conrelid join pg_namespace n on n.oid = cl.relnamespace where n.nspname = 'public' and k.contype <> 'n' and cl.relname in (${q(TABLES)}) group by cl.relname
  union all
  select i.tablename, 'indexes', string_agg(i.indexname || ' = ' || i.indexdef, ' , ' order by i.indexname)
  from pg_indexes i where i.schemaname = 'public' and i.tablename in (${q(TABLES)}) group by i.tablename
  union all
  select cl.relname, 'rls', cl.relrowsecurity::text
  from pg_class cl join pg_namespace n on n.oid = cl.relnamespace where n.nspname = 'public' and cl.relname in (${q(TABLES)})
  union all
  select p.tablename, 'policies', string_agg(p.policyname || ' / ' || p.cmd || ' / ' || p.roles::text || ' / ' || coalesce(p.qual, 'none') || ' / ' || coalesce(p.with_check, 'none'), ' , ' order by p.policyname)
  from pg_policies p where p.schemaname = 'public' and p.tablename in (${q(TABLES)}) group by p.tablename
  union all
  select t.t, 'write_grants', coalesce((select string_agg(g.grantee || ' = ' || g.privilege_type, ' , ' order by g.grantee, g.privilege_type) from (select distinct grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = t.t and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) g), 'none')
  from (values ${TABLES.map((x) => `('${x}')`).join(', ')}) as t(t)
  union all
  select cl.relname, 'triggers', string_agg(t.tgname || ' = ' || pg_get_triggerdef(t.oid), ' , ' order by t.tgname)
  from pg_trigger t join pg_class cl on cl.oid = t.tgrelid join pg_namespace n on n.oid = cl.relnamespace where n.nspname = 'public' and not t.tgisinternal and cl.relname in (${q(TABLES)}) group by cl.relname
  union all
  select pr.proname, 'function', string_agg(pg_get_function_identity_arguments(pr.oid) || ' / ' || pg_get_function_result(pr.oid) || ' / definer ' || pr.prosecdef::text || ' / ' || pr.provolatile::text || ' / ' || coalesce(array_to_string(pr.proconfig, ' '), 'none') || ' / body ' || md5(lower(regexp_replace(regexp_replace(pr.prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g'))) || ' / anon ' || has_function_privilege('anon', pr.oid, 'execute')::text || ' / authenticated ' || has_function_privilege('authenticated', pr.oid, 'execute')::text || ' / service ' || has_function_privilege('service_role', pr.oid, 'execute')::text, ' , ' order by pr.oid)
  from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = 'public' and pr.proname in (${q(FUNCTIONS)}) group by pr.proname
  union all
  select 'ii_risk_free_series', 'seed_rows', string_agg(s.series_id || ' / ' || s.series_name || ' / ' || s.role || ' / ' || s.source || ' / ' || s.attribution_text || ' / ' || s.cadence || ' / ' || s.max_staleness_days::text || ' / enabled ' || s.enabled::text || ' / ' || s.terms_review_status || ' / verified ' || coalesce(s.verified_through_date::text, 'none'), ' , ' order by s.series_id)
  from public.ii_risk_free_series s
  union all
  select a, 'absent', count(pr.oid)::text from (values ${ABSENT_FUNCTIONS.map((f) => `('${f}')`).join(', ')}) as v(a) left join pg_proc pr on pr.proname = v.a and pr.pronamespace = 'public'::regnamespace group by a
) raw`;
}

/** Information rows: counts of rows and of administrators holding the two permissions (not compared, reported). */
export function infoSelect() {
  return `select 'ii_risk_free_series' as object, 'row_count' as aspect, (select count(*) from public.ii_risk_free_series)::text as detail
  union all select 'ii_risk_free_batches', 'row_count', (select count(*) from public.ii_risk_free_batches)::text
  union all select 'ii_risk_free_observations', 'row_count', (select count(*) from public.ii_risk_free_observations)::text
  union all select 'ii_risk_free_review_items', 'row_count', (select count(*) from public.ii_risk_free_review_items)::text
  union all select 'ii_risk_free_corrections', 'row_count', (select count(*) from public.ii_risk_free_corrections)::text
  union all select 'ii_risk_free_series_state_log', 'row_count', (select count(*) from public.ii_risk_free_series_state_log)::text
  union all select 'admin_users', 'holders_of_upload_permission', (select count(*) from public.admin_users where can_upload_risk_free_data = true)::text
  union all select 'admin_users', 'holders_of_switch_permission', (select count(*) from public.admin_users where can_switch_risk_free_series = true)::text`;
}

const md5 = async (db, text) => (await db.query('select md5($1) as m', [text])).rows[0].m;

export async function stubDb() {
  const db = await PGlite.create();
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('test.uid', true), '')::uuid $f$;
    grant usage on schema auth to authenticated, anon;
    create table public.admin_users (user_id uuid primary key, notes text);`);
  return db;
}
export async function applyPartsAC(db) {
  for (const l of ['a', 'b', 'c']) await db.exec(fs.readFileSync(path.join(PARTS, `0260${l}.sql`), 'utf8'));
}

function header(title, what) {
  return `-- ${title}
-- Read only. ${what}
-- Written 17-10-2026 for the partial state found on production (0260 parts a, b and c are there, parts d and e and everything after are not).
-- Project check first: the address bar must contain twwpnltizhtjxhamyoxt. Paste the whole file, press Run, paste the answer back. Nothing is written.
-- Generated by scripts/nav2_reconcile_0260.mjs: the expected values are the fingerprints of the objects that 0260 parts a to c create, computed with this same query.
`;
}

export function detailSql(expected) {
  const values = expected.map((e) => `('${e.object}', '${e.aspect}', '${e.md5}')`).join(',\n    ');
  return `${header('P1z reconciliation, detail', 'One row per object and aspect: matches true means the object is exactly what 0260 creates. Rows with matches false show what the database holds in actual_text.')}
with fp as (
  ${fingerprintSelect().split('\n').join('\n  ')}
),
expected(object, aspect, expected_md5) as (values
    ${values}
),
compared as (
  select e.object, e.aspect,
    (f.actual is not null and md5(f.actual) = e.expected_md5) as matches,
    case when f.actual is not null and md5(f.actual) = e.expected_md5 then null else coalesce(left(f.actual, 1500), 'missing') end as actual_text
  from expected e left join fp f on f.object = e.object and f.aspect = e.aspect
)
select object, aspect, matches, actual_text from compared
union all
select object, aspect, null::boolean, detail from (${infoSelect().split('\n').join('\n  ')}) i
order by 1, 2;
`;
}

export function summarySql(expected) {
  const values = expected.map((e) => `('${e.object}', '${e.aspect}', '${e.md5}')`).join(',\n    ');
  return `${header('P1z reconciliation, summary', 'ONE row. all_match true means every pre-existing object is exactly the 0260 version and parts d and e are absent.')}
with fp as (
  ${fingerprintSelect().split('\n').join('\n  ')}
),
expected(object, aspect, expected_md5) as (values
    ${values}
),
compared as (
  select e.object, e.aspect, (f.actual is not null and md5(f.actual) = e.expected_md5) as matches
  from expected e left join fp f on f.object = e.object and f.aspect = e.aspect
)
select
  count(*) as checks,
  count(*) filter (where matches) as matching,
  count(*) filter (where not matches) as differing,
  bool_and(matches) as all_match,
  (select string_agg(object || '.' || aspect, ' , ' order by object, aspect) from compared where not matches) as differing_aspects,
  (select count(*) from public.ii_risk_free_series) as series_rows,
  (select count(*) from public.ii_risk_free_observations) + (select count(*) from public.ii_risk_free_batches) + (select count(*) from public.ii_risk_free_review_items) + (select count(*) from public.ii_risk_free_corrections) + (select count(*) from public.ii_risk_free_series_state_log) as data_rows_in_the_other_five_tables,
  (select count(*) from public.admin_users where can_upload_risk_free_data = true or can_switch_risk_free_series = true) as administrators_holding_a_permission
from compared;
`;
}

export async function expectedFingerprints(db) {
  const rows = (await db.query(`select object, aspect, actual from (${fingerprintSelect()}) x order by object, aspect`)).rows;
  const out = [];
  for (const r of rows) out.push({ object: r.object, aspect: r.aspect, text: r.actual, md5: await md5(db, r.actual) });
  return out;
}

async function generate() {
  const db = await stubDb();
  await applyPartsAC(db);
  const expected = await expectedFingerprints(db);
  await db.close();
  fs.mkdirSync(INV, { recursive: true });
  fs.writeFileSync(path.join(INV, 'expected_0260_abc_fingerprints.json'), JSON.stringify(expected, null, 1));
  fs.writeFileSync(path.join(PRE, 'P1z_reconcile_partial_0260_detail.sql'), detailSql(expected));
  fs.writeFileSync(path.join(PRE, 'P1z_reconcile_partial_0260_summary.sql'), summarySql(expected));
  console.log(`expected fingerprints: ${expected.length} (objects x aspects); wrote 2 SQL files and the readable expected text`);
}

// ---- compare the production catalog inventory (jsonb of nav2_catalog_inventory.sql) with the expected inventory, restricted to parts a to c ----
export function parseInventory(raw) {
  let text = raw.replace(/^\uFEFF/, '').trim();
  // a CSV export of one jsonb cell: a header line, then the value wrapped in quotes with doubled quotes
  const header = /^"?inventory"?\s*\r?\n/i;
  if (header.test(text)) text = text.replace(header, '').trim();
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).replace(/""/g, '"');
  return JSON.parse(text);
}

export function compareInventories(actual, expected) {
  const scopeTables = new Set(TABLES);
  const inScope = (section, row) => {
    if (section === 'columns') return scopeTables.has(row[0]) || (row[0] === 'admin_users' && ADMIN_COLUMNS.includes(row[1]));
    // NOT NULL entries (contype n) exist in pg_constraint only from Postgres 18: nullability is compared in the columns section instead
    if (section === 'constraints') return scopeTables.has(row[0]) && row[2] !== 'n';
    if (['indexes', 'rls', 'policies', 'grants'].includes(section)) return scopeTables.has(row[0]);
    if (section === 'triggers') return scopeTables.has(row[0]);
    if (section === 'functions') return FUNCTIONS.includes(row[0]);
    if (section === 'series_seed') return true;
    return false;
  };
  const key = (s, r) => (s === 'functions' ? `${r[0]}(${r[1]})` : s === 'columns' ? `${r[0]}.${r[1]}` : s === 'series_seed' ? r[0] : s === 'triggers' ? `${r[0]}.${r[1]}` : s === 'constraints' ? `${r[0]}.${r[1]}` : s === 'indexes' ? `${r[0]}.${r[1]}` : s === 'policies' ? `${r[0]}.${r[1]}` : s === 'rls' ? r[0] : `${r[0]}.${r[1]}.${r[2]}`);
  const problems = [];
  const notes = [];
  for (const s of ['columns', 'constraints', 'indexes', 'rls', 'policies', 'grants', 'triggers', 'functions', 'series_seed']) {
    const e = new Map((expected[s] ?? []).filter((r) => inScope(s, r)).map((r) => [key(s, r), r]));
    const a = new Map((actual[s] ?? []).filter((r) => inScope(s, r)).map((r) => [key(s, r), r]));
    for (const [k, r] of e) {
      if (!a.has(k)) { problems.push(`${s}: MISSING on production: ${k}`); continue; }
      const x = a.get(k);
      if (s === 'functions') {
        const same = JSON.stringify([r[0], r[1], r[2], r[3], r[4], r[6], r[7], r[8], r[9]]) === JSON.stringify([x[0], x[1], x[2], x[3], x[4], x[6], x[7], x[8], x[9]]);
        if (!same) problems.push(`${s}: DIFFERENT ${k}\n    expected ${JSON.stringify(r.filter((_, i) => i !== 5))}\n    actual   ${JSON.stringify(x.filter((_, i) => i !== 5))}`);
        else if (r[5] !== x[5]) notes.push(`${s}: ${k} body differs only in comments or white space`);
        continue;
      }
      if (s === 'series_seed') {
        if (JSON.stringify(r.slice(0, 4)) !== JSON.stringify(x.slice(0, 4))) problems.push(`${s}: DIFFERENT ${k}\n    expected ${JSON.stringify(r)}\n    actual   ${JSON.stringify(x)}`);
        else if (r[4] !== x[4]) problems.push(`${s}: ${k} terms_review_status is ${x[4]}, expected ${r[4]}`);
        continue;
      }
      if (JSON.stringify(r) !== JSON.stringify(x)) problems.push(`${s}: DIFFERENT ${k}\n    expected ${JSON.stringify(r)}\n    actual   ${JSON.stringify(x)}`);
    }
    for (const k of a.keys()) if (!e.has(k)) problems.push(`${s}: EXTRA on production (not in 0260 a to c): ${k}`);
  }
  // parts d, e and later must be absent
  const names = new Set((actual.functions ?? []).map((r) => r[0]));
  for (const f of ABSENT_FUNCTIONS) if (names.has(f)) problems.push(`functions: ${f} (part d or e) is ALREADY on production`);
  const later = (actual.columns ?? []).filter((r) => String(r[0]).startsWith('nav2_')).length;
  if (later) problems.push(`${later} column rows of nav2_ tables are already on production`);
  return { problems, notes };
}

function compareInventory(actualFile) {
  const actual = parseInventory(fs.readFileSync(actualFile, 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(INV, 'expected_inventory.json'), 'utf8'));
  const { problems, notes } = compareInventories(actual, expected);
  console.log(`production inventory compared with 0260 parts a to c: ${problems.length === 0 ? 'EXACT: every pre-existing object is the 0260 version, parts d and e are absent' : `${problems.length} DIFFERENCE(S)`}`);
  for (const p of problems) console.log(`  - ${p}`);
  for (const n of notes) console.log(`  note: ${n}`);
  console.log(`seed rows on production: ${JSON.stringify(actual.series_seed)}`);
  console.log(`job keys on production: ${JSON.stringify(actual.job_keys)}`);
  process.exitCode = problems.length ? 1 : 0;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'generate') await generate();
else if (cmd === 'compare') compareInventory(arg);
else if (cmd) { console.log('usage: generate | compare <file>'); process.exit(2); }
