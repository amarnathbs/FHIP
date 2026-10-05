/**
 * READ-ONLY DEV probe for migration 0236 (owner-before-upload, phase 1).
 *
 *   node scripts/canonical_cert/final/dev_0236_state_probe.mjs [--json]
 *
 * - Prints and verifies the target host is the DEV project (the harness env loader REFUSES otherwise).
 * - Prerequisites: tables / columns / functions of 0032, 0153, 0154, 0207 and the AIE tables.
 * - Classification of 0236: NOT APPLIED / ALREADY APPLIED (columns + function) / PARTIAL.
 *   Columns and functions are read from the PostgREST OpenAPI document; the pure function
 *   owner_before_upload_allocation_ok is also CALLED (no side effects) to prove its behaviour.
 * - Constraints, triggers and indexes cannot be seen through PostgREST: they are listed as
 *   NOT DETERMINABLE here and are covered by the PO's schema verification SQL.
 * - Anti-vacuity: a sentinel column that no migration creates MUST be reported missing.
 * No write of any kind is issued.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadDevEnv, serviceClient } from '../lib/env.mjs';

// (copied from ../dev_migration_presence_probe.mjs, which runs its own main() on import)
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const topLevel = (sql) => sql.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, ' $body$ ');
function expectationsFor(file) {
  const raw = stripComments(fs.readFileSync(file, 'utf8'));
  const sql = topLevel(raw);
  const columns = []; const tables = []; const rpcs = [];
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z0-9_]+)([^;]*);/gi)) {
    const table = m[1].toLowerCase();
    for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi)) columns.push([table, c[1].toLowerCase()]);
  }
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)/gi)) tables.push(m[1].toLowerCase());
  for (const m of raw.matchAll(/create\s+or\s+replace\s+function\s+((?:[a-z0-9_]+\.)?[a-z0-9_]+)\s*\(([^)]*)\)\s*returns\s+([a-z_]+)/gi)) {
    const name = m[1].toLowerCase();
    if (name.startsWith('pg_temp.') || m[3].toLowerCase() === 'trigger') continue;
    rpcs.push(name.replace(/^public\./, ''));
  }
  return { columns, tables: [...new Set(tables)], rpcs: [...new Set(rpcs)] };
}

const dir = path.resolve(process.cwd(), 'supabase', 'migrations');
const fileFor = (n) => fs.readdirSync(dir).find((f) => f.startsWith(`${n}_`));

async function openapi() {
  const { url, serviceKey } = loadDevEnv();
  const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/openapi+json' } });
  if (!res.ok) throw new Error(`OpenAPI GET failed: HTTP ${res.status}`);
  return res.json();
}

const { url, ref } = loadDevEnv();
const host = new URL(url).host;
if (host !== 'vqycarelcoijzwlpkpcz.supabase.co') { console.error(`REFUSING: host ${host} is not the DEV project`); process.exit(3); }
const asJson = process.argv.includes('--json');
const api = await openapi();
const defs = api.definitions ?? {};
const paths = api.paths ?? {};
const hasTable = (t) => Boolean(defs[t]);
const hasCol = (t, c) => Boolean(defs[t]?.properties?.[c]);
const report = { host, ref, prerequisites: {}, migration0236: {}, sentinel: {}, counts: {} };

// ---- prerequisites, read from the migration files themselves
for (const n of ['0032', '0140', '0141', '0142', '0153', '0154', '0207']) {
  const f = fileFor(n);
  if (!f) { report.prerequisites[n] = { file: null, verdict: 'FILE MISSING' }; continue; }
  const e = expectationsFor(path.join(dir, f));
  const missing = [
    ...e.columns.filter(([t, c]) => !hasCol(t, c)).map(([t, c]) => `${t}.${c}`),
    ...e.tables.filter((t) => !hasTable(t)).map((t) => `table ${t}`),
    ...e.rpcs.filter((r) => !paths[`/rpc/${r}`]).map((r) => `rpc ${r}`),
  ];
  const total = e.columns.length + e.tables.length + e.rpcs.length;
  report.prerequisites[n] = { file: f, checked: total, missing, verdict: total === 0 ? 'NOT DETERMINABLE' : missing.length === 0 ? 'PRESENT' : missing.length === total ? 'ABSENT' : 'PARTIAL' };
}
const named = {
  'household_members': hasTable('household_members'),
  'business_entities': hasTable('business_entities'),
  'fdh_statement_uploads': hasTable('fdh_statement_uploads'),
  'ii_source_documents': hasTable('ii_source_documents'),
  'ii_ownership_allocation (0153)': hasTable('ii_ownership_allocation'),
  'fdh_financial_accounts.owner_role (0207)': hasCol('fdh_financial_accounts', 'owner_role'),
  'ii_source_documents.owner_member_id (0032)': hasCol('ii_source_documents', 'owner_member_id'),
  'aie_document_intake': hasTable('aie_document_intake'),
  'aie_extraction_run': hasTable('aie_extraction_run'),
  'smsf_funds': hasTable('smsf_funds'),
};
report.prerequisites.named = named;

// ---- 0236 columns (parsed from the file) + the AIE column that lives inside a DO block
const f0236 = fileFor('0236');
const exp = expectationsFor(path.join(dir, f0236));
const cols = [...exp.columns, ['aie_document_intake', 'owner_selection']];
const present = cols.filter(([t, c]) => hasCol(t, c)).map(([t, c]) => `${t}.${c}`);
const absent = cols.filter(([t, c]) => !hasCol(t, c)).map(([t, c]) => `${t}.${c}`);
const fnPresent = Boolean(paths['/rpc/owner_before_upload_allocation_ok']);
const trigFnVisible = Boolean(paths['/rpc/owner_before_upload_assert_owner']); // trigger fn: revoked/not exposed; informational
report.migration0236 = { file: f0236, expectedColumns: cols.length, present, absent, allocationFnVisible: fnPresent, triggerFnExposedAsRpc: trigFnVisible };

if (fnPresent) {
  const sb = await serviceClient();
  const a = crypto.randomUUID(); const b = crypto.randomUUID();
  const cases = [
    ['valid 6000/4000', [{ ownerMemberId: a, basisPoints: 6000 }, { ownerMemberId: b, basisPoints: 4000 }], true],
    ['9999 total', [{ ownerMemberId: a, basisPoints: 6000 }, { ownerMemberId: b, basisPoints: 3999 }], false],
    ['10001 total', [{ ownerMemberId: a, basisPoints: 6001 }, { ownerMemberId: b, basisPoints: 4000 }], false],
    ['one owner', [{ ownerMemberId: a, basisPoints: 10000 }], false],
    ['duplicate owner', [{ ownerMemberId: a, basisPoints: 5000 }, { ownerMemberId: a, basisPoints: 5000 }], false],
    ['zero share', [{ ownerMemberId: a, basisPoints: 0 }, { ownerMemberId: b, basisPoints: 10000 }], false],
    ['negative share', [{ ownerMemberId: a, basisPoints: -1000 }, { ownerMemberId: b, basisPoints: 11000 }], false],
    ['fractional share', [{ ownerMemberId: a, basisPoints: 5000.5 }, { ownerMemberId: b, basisPoints: 4999.5 }], false],
  ];
  report.migration0236.allocationFnBehaviour = [];
  for (const [name, arg, want] of cases) {
    const { data, error } = await sb.rpc('owner_before_upload_allocation_ok', { p_alloc: arg });
    report.migration0236.allocationFnBehaviour.push({ name, want, got: error ? `error ${error.code}` : data, ok: !error && data === want });
  }
}
// ---- column COMMENTS (exact text) and FK targets, compared with the migration file itself
{
  const raw = fs.readFileSync(path.join(dir, f0236), 'utf8');
  const wantComments = [...raw.matchAll(/comment\s+on\s+column\s+public\.([a-z0-9_]+)\.([a-z0-9_]+)\s+is\s*\n?\s*'((?:[^']|'')*)'/gi)]
    .map((m) => ({ t: m[1], c: m[2], text: m[3].replace(/''/g, "'") }));
  report.migration0236.comments = wantComments.map((w) => {
    const got = defs[w.t]?.properties?.[w.c]?.description ?? null;
    return { column: `${w.t}.${w.c}`, exact: got === w.text };
  });
  const wantFks = [['fdh_statement_uploads', 'owner_member_id', 'household_members'], ['fdh_statement_uploads', 'owner_business_entity_id', 'business_entities'],
    ['ii_source_documents', 'owner_business_entity_id', 'business_entities']];
  report.migration0236.foreignKeys = wantFks.map(([t, c, target]) => ({ column: `${t}.${c}`, target, ok: (defs[t]?.properties?.[c]?.description ?? '').includes(`<fk table='${target}' column='id'/>`) }));
  report.migration0236.commentsExact = report.migration0236.comments.length >= 5 && report.migration0236.comments.every((c) => c.exact);
  report.migration0236.fksOk = report.migration0236.foreignKeys.every((f) => f.ok);
}
const colsAll = absent.length === 0; const colsNone = present.length === 0;
report.migration0236.verdict = colsNone && !fnPresent ? 'NOT APPLIED'
  : colsAll && fnPresent ? 'COLUMNS + FUNCTION PRESENT (constraints/triggers need the PO schema verification SQL to prove exact match)'
  : 'PARTIALLY APPLIED';

// ---- anti-vacuity
const sentinel = `cert_probe_sentinel_${crypto.randomBytes(3).toString('hex')}`;
report.sentinel = { column: `fdh_statement_uploads.${sentinel}`, reportedMissing: !hasCol('fdh_statement_uploads', sentinel), tableVisible: hasTable('fdh_statement_uploads') };

// ---- read-only row counts (context for the backfill preview)
const sb = await serviceClient();
for (const t of ['fdh_statement_uploads', 'ii_source_documents', 'fdh_financial_accounts', 'ii_accounts', 'ii_ownership_allocation', 'aie_document_intake', 'household_members', 'business_entities']) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
  report.counts[t] = error ? `error ${error.code}` : count;
}

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`DEV host: ${host}  (verified DEV project ${ref}; production never touched)`);
  for (const [n, r] of Object.entries(report.prerequisites)) if (n !== 'named') console.log(`prereq ${n}: ${r.verdict}${r.missing?.length ? ' MISSING ' + r.missing.join(', ') : ''}`);
  for (const [k, v] of Object.entries(named)) console.log(`  ${v ? 'OK     ' : 'MISSING'} ${k}`);
  console.log(`0236 columns present ${present.length}/${cols.length}${absent.length ? ' absent: ' + absent.join(', ') : ''}; allocation fn visible: ${fnPresent}`);
  for (const c of report.migration0236.allocationFnBehaviour ?? []) console.log(`  fn ${c.ok ? 'OK ' : 'BAD'} ${c.name}: want ${c.want} got ${c.got}`);
  for (const c of report.migration0236.comments) console.log(`  comment ${c.exact ? 'EXACT' : 'DIFFERS'} ${c.column}`);
  for (const k of report.migration0236.foreignKeys) console.log(`  fk ${k.ok ? 'OK ' : 'BAD'} ${k.column} -> ${k.target}`);
  console.log(`0236 verdict: ${report.migration0236.verdict}`);
  console.log(`row counts: ${JSON.stringify(report.counts)}`);
  console.log(`sentinel ${report.sentinel.column} reported missing: ${report.sentinel.reportedMissing}`);
}
if (!report.sentinel.reportedMissing || !report.sentinel.tableVisible) { console.error('ANTI-VACUITY FAILED'); process.exit(2); }
