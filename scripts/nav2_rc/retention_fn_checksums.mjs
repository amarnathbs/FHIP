// NAV2 release candidate: the NORMALIZED checksums of pc6_nav_row_is_candidate as defined by migration 0219 (the production predecessor) and by 0261.
// Normalized = comments removed, whitespace removed, lower case, then md5: it survives re-formatting and comment edits, unlike md5 of the raw text.
// Run: node scripts/nav2_rc/retention_fn_checksums.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIG = path.resolve(HERE, '..', '..', 'supabase', 'migrations');
function functionSql(file) {
  const t = fs.readFileSync(path.join(MIG, file), 'utf8');
  const start = t.search(/create or replace function pc6_nav_row_is_candidate\(/i);
  if (start < 0) throw new Error(`no definition in ${file}`);
  const m = /as\s+(\$[a-z]*\$)/i.exec(t.slice(start));
  const tag = m[1];
  const open = start + m.index + m[0].length - tag.length;
  const close = t.indexOf(tag, open + tag.length);
  return t.slice(start, close + tag.length) + ';';
}
const db = await PGlite.create();
await db.exec('set check_function_bodies = off;');
const NORM = `md5(lower(regexp_replace(regexp_replace(p.prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g')))`;
const out = {};
for (const [label, file] of [['0219', '0219_nav1_merger_lineage_and_coverage_gaps.sql'], ['0261', '0261_nav2_fund_analytics_reports_cache_and_pinning.sql']]) {
  await db.exec(`drop function if exists pc6_nav_row_is_candidate(uuid, date, date); ${functionSql(file)}`);
  const r = await db.query(`select md5(p.prosrc) as raw_md5, ${NORM} as normalized_md5, length(p.prosrc) as len from pg_proc p where p.oid = 'public.pc6_nav_row_is_candidate(uuid, date, date)'::regprocedure`);
  out[label] = r.rows[0];
}
console.log(JSON.stringify(out, null, 2));
