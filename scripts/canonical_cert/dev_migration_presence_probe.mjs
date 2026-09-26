/**
 * READ-ONLY probe: are migrations 0199-0201 and 0207-0214 present on DEV?
 *
 * Method: the expectations are PARSED FROM THE MIGRATION FILES THEMSELVES (not hand-typed):
 *   - every `alter table T ... add column [if not exists] C`  -> column C must appear on T
 *   - every `create table [if not exists] T`                  -> table T must appear
 *   - every `create or replace function F(...)` that is NOT `returns trigger` and not pg_temp
 *                                                             -> /rpc/F must appear
 * checked against DEV's PostgREST OpenAPI document (GET only, service role).
 *
 * Extra behavioural (still read-only) checks for 0200:
 *   - calling /rpc/pc6_nav_row_is_candidate with the ANON key must be refused (0200 revokes
 *     anon/authenticated; Supabase serves OpenAPI only to secret keys, so it is called instead);
 *   - pc6_nav_row_is_candidate(random uuid, today, NULL) must return false, never NULL (0200 fix).
 * 0201 adds only indexes, which PostgREST cannot see: reported as NOT DETERMINABLE here.
 *
 * Anti-vacuity: a sentinel column that no migration creates is checked too and MUST be reported
 * missing, otherwise the probe exits non-zero (proves the column check can fail).
 *
 * Usage: node scripts/canonical_cert/dev_migration_presence_probe.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadDevEnv, serviceClient, anonClient } from './lib/env.mjs';

const MIGRATIONS = ['0199', '0200', '0201', '0207', '0208', '0209', '0210', '0211', '0212', '0213', '0214'];
const dir = path.resolve(process.cwd(), 'supabase', 'migrations');

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Split out $$...$$ function bodies so DDL inside them is not mistaken for top-level DDL. */
function topLevel(sql) {
  return sql.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, ' $body$ ');
}

export function expectationsFor(file) {
  const raw = stripComments(fs.readFileSync(file, 'utf8'));
  const sql = topLevel(raw);
  const columns = []; const tables = []; const rpcs = [];
  // alter table statements up to the terminating semicolon
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z0-9_]+)([^;]*);/gi)) {
    const table = m[1].toLowerCase();
    for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi)) columns.push([table, c[1].toLowerCase()]);
  }
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi)) tables.push(m[1].toLowerCase());
  // functions: look at the raw text (the header is outside $$) and read the returns clause
  for (const m of raw.matchAll(/create\s+or\s+replace\s+function\s+((?:[a-z0-9_]+\.)?[a-z0-9_]+)\s*\(([^)]*)\)\s*returns\s+([a-z_]+)/gi)) {
    const name = m[1].toLowerCase();
    if (name.startsWith('pg_temp.')) continue;
    if (m[3].toLowerCase() === 'trigger') continue;
    rpcs.push(name.replace(/^public\./, ''));
  }
  return { columns, tables: [...new Set(tables)], rpcs: [...new Set(rpcs)] };
}

async function openapi(key) {
  const { url } = loadDevEnv();
  const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' } });
  if (!res.ok) throw new Error(`OpenAPI GET failed: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const asJson = process.argv.includes('--json');
  const { serviceKey, ref } = loadDevEnv();
  const svc = await openapi(serviceKey);
  const defs = svc.definitions ?? {};
  const paths = svc.paths ?? {};
  const hasCol = (t, c) => Boolean(defs[t]?.properties?.[c]);
  const report = { project: ref, generatedAt: new Date().toISOString(), migrations: {}, sentinel: null, nav0200: {} };

  for (const num of MIGRATIONS) {
    const file = fs.readdirSync(dir).find((f) => f.startsWith(`${num}_`));
    if (!file) { report.migrations[num] = { file: null, verdict: 'FILE MISSING ON BRANCH' }; continue; }
    const exp = expectationsFor(path.join(dir, file));
    const missingCols = exp.columns.filter(([t, c]) => !hasCol(t, c)).map(([t, c]) => `${t}.${c}`);
    const missingTables = exp.tables.filter((t) => !defs[t]);
    const missingRpcs = exp.rpcs.filter((f) => !paths[`/rpc/${f}`]);
    // An RPC that an EARLIER migration already defined proves nothing about THIS migration
    // (CREATE OR REPLACE of an existing name). Only NEW RPCs count as evidence.
    const earlier = fs.readdirSync(dir).filter((f) => /^\d{4}_/.test(f) && f < file).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    const newRpcs = exp.rpcs.filter((fn) => !earlier.some((txt) => new RegExp(`function\\s+(public\\.)?${fn}\\s*\\(`, 'i').test(txt)));
    const evidence = exp.columns.length + exp.tables.length + newRpcs.length;
    const missingEvidence = missingCols.length + missingTables.length + newRpcs.filter((f) => missingRpcs.includes(f)).length;
    report.migrations[num] = {
      file,
      checked: { columns: exp.columns.length, tables: exp.tables.length, rpcs: exp.rpcs.length, newRpcs: newRpcs.length },
      newRpcs,
      missing: { columns: missingCols, tables: missingTables, rpcs: missingRpcs },
      verdict: evidence === 0 ? 'NOT DETERMINABLE VIA OPENAPI (no new visible objects)' : missingEvidence === 0 ? 'PRESENT' : missingEvidence === evidence ? 'ABSENT' : 'PARTIAL',
    };
  }

  // Anti-vacuity: a column no migration creates must be reported missing.
  const sentinel = `cert_probe_sentinel_${crypto.randomBytes(3).toString('hex')}`;
  report.sentinel = { column: `assets.${sentinel}`, reportedMissing: !hasCol('assets', sentinel), assetsTableVisible: Boolean(defs.assets) };

  // 0200 behavioural checks (read-only).
  const probeArgs = { p_instrument_id: crypto.randomUUID(), p_price_date: new Date().toISOString().slice(0, 10), p_changeover_date: null };
  {
    const { data, error } = await (await anonClient()).rpc('pc6_nav_row_is_candidate', probeArgs);
    report.nav0200.anonCall = error ? `refused: ${error.code}` : `EXECUTED -> ${JSON.stringify(data)}`;
    report.nav0200.anonCanExecute = !error;
  }
  report.nav0200.serviceCanSeeRpc = Boolean(paths['/rpc/pc6_nav_row_is_candidate']);
  try {
    const sb = await serviceClient();
    const { data, error } = await sb.rpc('pc6_nav_row_is_candidate', probeArgs);
    report.nav0200.nullChangeoverResult = error ? `error: ${error.code} ${error.message}` : data;
  } catch (e) { report.nav0200.nullChangeoverResult = `error: ${e.message}`; }
  report.nav0200.verdict = report.nav0200.serviceCanSeeRpc && !report.nav0200.anonCanExecute && report.nav0200.nullChangeoverResult === false
    ? 'PRESENT (revoke from anon + NULL changeover returns false)'
    : 'ABSENT OR PARTIAL';
  report.migrations['0200'].verdict = report.nav0200.verdict;
  report.migrations['0201'].note = '0201 creates indexes only; PostgREST cannot show indexes. Confirm with pg_indexes in the SQL editor (PO).';

  if (asJson) { console.log(JSON.stringify(report, null, 2)); }
  else {
    console.log(`DEV project: ${ref}`);
    for (const [num, r] of Object.entries(report.migrations)) {
      const c = r.checked ? `new cols ${r.checked.columns}, new tables ${r.checked.tables}, new rpcs ${r.checked.newRpcs} (rpcs replaced ${r.checked.rpcs - r.checked.newRpcs})` : '';
      const miss = r.missing ? [...r.missing.columns, ...r.missing.tables, ...r.missing.rpcs.map((f) => `rpc:${f}`)] : [];
      console.log(`${num}  ${r.verdict.padEnd(12)} ${c}${miss.length ? `  MISSING: ${miss.join(', ')}` : ''}`);
    }
    console.log(`0200 behaviour: anon call ${report.nav0200.anonCall}, service sees rpc=${report.nav0200.serviceCanSeeRpc}, NULL changeover -> ${JSON.stringify(report.nav0200.nullChangeoverResult)}  => ${report.nav0200.verdict}`);
    console.log(`anti-vacuity sentinel ${report.sentinel.column}: reported missing=${report.sentinel.reportedMissing}`);
  }
  if (!report.sentinel.reportedMissing || !report.sentinel.assetsTableVisible) { console.error('ANTI-VACUITY FAILED: the probe cannot detect a missing column.'); process.exit(2); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
