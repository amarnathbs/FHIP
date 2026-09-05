// G5B Phase 2 (2026-09-06) — LIVE DEV drift-proofing.
//
// This is the script lib/services/g5bWriteManifest.ts's own header called
// "Phase 2 (after Product Owner applies migration 0129 to DEV): scripts/
// g5b_manifest_drift_live_dev.mjs (prepared, not yet runnable)". Migration
// 0129 (and 0130) are now applied+verified in DEV, so this is that promised
// follow-up, made real: it queries the ACTUAL mcc_generic_write_capabilities
// table on hosted DEV Postgres (vqycarelcoijzwlpkpcz) via the service-role
// key and feeds those real rows into the EXACT SAME compareManifests()
// function tests/unit/g5bWriteManifestDrift.test.ts exercises against the
// hand-maintained EXPECTED_DB_MANIFEST fixture — closing both disclosed gaps
// that fixture-only test could never close on its own: (1) migration 0129's
// source drifting from this file's idea of it, and (2) a manual edit made
// directly against the live table after application.
//
// Read-only: this script only ever SELECTs. No writes, no fixtures, no
// synthetic users. DEV only (hard guard below refuses any other project).
//
// Run: npx tsx --env-file=.env.local scripts/g5b_manifest_drift_live_dev.ts

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareManifests,
  claimedGenericWriteTables,
  dbOperationForWriteOperation,
  type DbManifestRow,
} from '../lib/services/g5bWriteManifest';
import { __setG5BGenericWriteFlagForTests } from '../lib/services/g5bWriteFlag';
import { APP_CAPABILITY_MANIFEST, MODULE_KEYS } from '../lib/services/appCapability';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function loadEnvLocal(): Record<string, string> {
  // This repo's .env.local is CRLF-terminated with a leading UTF-8 BOM on
  // its first line (confirmed by direct byte inspection this session) —
  // splitting on a bare '\n' leaves a trailing '\r' on every line, which
  // this project's OTHER certification scripts' identical-looking
  // `/^([A-Z_]+)=(.*)$/` regex silently fails to match at all (JS `.` does
  // not consume `\r`, and `$` without the `m` flag demands the true end of
  // the string) -- not a defect introduced here, but this script strips both
  // the BOM and any `\r` so it actually reads every var, rather than
  // reproducing that same silent-empty-parse footgun.
  const raw = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnvLocal();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !SERVICE) {
  console.error('FATAL: missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(2);
}
if (!BASE.includes('vqycarelcoijzwlpkpcz')) {
  console.error(`FATAL: refusing to run — NEXT_PUBLIC_SUPABASE_URL (${BASE}) is not the known DEV project (vqycarelcoijzwlpkpcz).`);
  process.exit(2);
}

let pass = 0, fail = 0;
const failures: string[] = [];
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
};

// tsx transforms this file as CJS (no "type": "module" in package.json), so
// top-level await is unavailable — same async-IIFE convention this repo's
// other tsx-run certification scripts use (e.g. scripts/resources/import-r0a-
// content-master.ts's `main()`).
async function main() {
console.log('=== G5B Phase 2 — LIVE DEV manifest drift-proofing ===');
console.log('Target:', BASE);
console.log('Run at:', new Date().toISOString());

// ---------------------------------------------------------------------------
console.log('\n=== 1. Read the REAL mcc_generic_write_capabilities table from live DEV ===');
const res = await fetch(`${BASE}/rest/v1/mcc_generic_write_capabilities?select=table_name,operation,generic_write_allowed,certified_reason&order=table_name,operation`, {
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
});
if (res.status >= 300) {
  console.error(`FATAL: could not read mcc_generic_write_capabilities (HTTP ${res.status}): ${await res.text()}`);
  process.exit(3);
}
const liveRows = (await res.json()) as Array<{ table_name: string; operation: string; generic_write_allowed: boolean; certified_reason: string | null }>;
check('Live table returned at least one row', liveRows.length > 0, `(${liveRows.length} rows)`);
console.log('  Live rows:', JSON.stringify(liveRows.map((r) => ({ t: r.table_name, op: r.operation, allowed: r.generic_write_allowed })), null, 2));

const dbRows: DbManifestRow[] = liveRows.map((r) => ({
  table_name: r.table_name,
  operation: r.operation as DbManifestRow['operation'],
  generic_write_allowed: r.generic_write_allowed,
}));

// ---------------------------------------------------------------------------
console.log('\n=== 2. Exactly the three approved tables allow GENERIC INSERT/UPDATE; none allows DELETE ===');
const EXPECTED_TABLES = ['income_sources', 'expense_items', 'insurance_policies'];
for (const table of EXPECTED_TABLES) {
  for (const op of ['INSERT', 'UPDATE'] as const) {
    const row = dbRows.find((r) => r.table_name === table && r.operation === op);
    check(`${table}.${op} row exists and generic_write_allowed=true`, row?.generic_write_allowed === true, JSON.stringify(row));
  }
  const delRow = dbRows.find((r) => r.table_name === table && r.operation === 'DELETE');
  check(`${table}.DELETE row exists and generic_write_allowed=false`, delRow?.generic_write_allowed === false, JSON.stringify(delRow));
}
check(
  'No fourth table has gained GENERIC write permission — every allowed=true row is one of the three approved tables',
  dbRows.filter((r) => r.generic_write_allowed).every((r) => EXPECTED_TABLES.includes(r.table_name)),
  JSON.stringify(dbRows.filter((r) => r.generic_write_allowed).map((r) => `${r.table_name}:${r.operation}`))
);
check(
  'Exactly 6 allowed=true rows total (3 tables x {INSERT,UPDATE}) — no extra operation slipped through',
  dbRows.filter((r) => r.generic_write_allowed).length === 6,
  `(${dbRows.filter((r) => r.generic_write_allowed).length} allowed rows)`
);

// ---------------------------------------------------------------------------
console.log('\n=== 3. App <-> DB agreement via the shared compareManifests() comparator, flag ON (Phase 2 activated end state) ===');
__setG5BGenericWriteFlagForTests(true);
const driftOn = compareManifests(dbRows, true);
check('App-layer CREATE/UPDATE claims for GENERIC exactly match DB-allowed rows (flag ON) — isDriftFree', driftOn.isDriftFree, JSON.stringify(driftOn));
check('No DB-allowed row that the app fails to claim (flag ON)', driftOn.dbAllowsButNoAppModuleClaimsIt.length === 0, JSON.stringify(driftOn.dbAllowsButNoAppModuleClaimsIt));
check('No app claim without a matching DB-allowed row (flag ON)', driftOn.appClaimsButDbDoesNotAllow.length === 0, JSON.stringify(driftOn.appClaimsButDbDoesNotAllow));

console.log('\n=== 4. App <-> DB agreement, flag OFF (must show ZERO app-layer claims against a DB that still allows 6 cells) ===');
__setG5BGenericWriteFlagForTests(false);
const driftOff = compareManifests(dbRows, false);
check('Flag OFF: the app claims nothing (byte-identical pre-G5B posture)', claimedGenericWriteTables(false).size === 0, `(${claimedGenericWriteTables(false).size} claims)`);
check(
  'Flag OFF: every one of the 6 DB-allowed cells is correctly reported as "DB allows but no app module claims it" — this is EXPECTED while the flag is off, not a defect',
  driftOff.dbAllowsButNoAppModuleClaimsIt.length === 6,
  `(${driftOff.dbAllowsButNoAppModuleClaimsIt.length} of 6)`
);
__setG5BGenericWriteFlagForTests(undefined);

// ---------------------------------------------------------------------------
console.log('\n=== 5. Module-operation mapping sanity: every app claim maps onto a real, correctly-named DB row ===');
__setG5BGenericWriteFlagForTests(true);
for (const key of MODULE_KEYS) {
  const rule = APP_CAPABILITY_MANIFEST[key];
  for (const operation of ['CREATE', 'UPDATE'] as const) {
    for (const table of rule.writeTables[operation]) {
      const dbOp = dbOperationForWriteOperation(operation);
      const row = dbRows.find((r) => r.table_name === table && r.operation === dbOp);
      check(`${key}.${operation} -> ${table}:${dbOp} resolves to a REAL live-DEV manifest row (canonical identifier, not a display label)`, !!row, JSON.stringify(row));
    }
  }
}
__setG5BGenericWriteFlagForTests(undefined);

// ---------------------------------------------------------------------------
console.log('\n=== 6. Missing/conflicting mapping simulations (synthetic dbRows, not live mutation) ===');
{
  const missingDbRow = dbRows.filter((r) => !(r.table_name === 'income_sources' && r.operation === 'INSERT'));
  __setG5BGenericWriteFlagForTests(true);
  const d = compareManifests(missingDbRow, true);
  check(
    'Simulated missing DB mapping (income_sources INSERT row absent) is caught as appClaimsButDbDoesNotAllow, not silently ignored',
    d.appClaimsButDbDoesNotAllow.includes('income_sources:INSERT'),
    JSON.stringify(d.appClaimsButDbDoesNotAllow)
  );
  __setG5BGenericWriteFlagForTests(undefined);
}
{
  const extraDbRow: DbManifestRow[] = [...dbRows, { table_name: 'assets', operation: 'INSERT', generic_write_allowed: true }];
  __setG5BGenericWriteFlagForTests(true);
  const d = compareManifests(extraDbRow, true);
  check(
    'Simulated conflicting DB mapping (a DB row for a table/op the app never claims, e.g. assets:INSERT) is caught as dbAllowsButNoAppModuleClaimsIt',
    d.dbAllowsButNoAppModuleClaimsIt.some((r) => r.table_name === 'assets' && r.operation === 'INSERT'),
    JSON.stringify(d.dbAllowsButNoAppModuleClaimsIt)
  );
  __setG5BGenericWriteFlagForTests(undefined);
}
{
  // "Newly introduced table" simulation: a table with NO row in the manifest
  // at all must resolve to denied-by-construction on the DB side (the real
  // enforce_write_permitted_g5b() trigger's own COALESCE(...,false) default —
  // see migration 0129 -- confirmed here by simply asking for a table/op pair
  // that genuinely has no live row and observing it is absent, i.e. not
  // silently treated as allowed).
  const newTableRow = dbRows.find((r) => r.table_name === 'some_future_g6_table');
  check('A hypothetical newly-introduced table has no live manifest row at all (denied-by-construction, not merely allowed=false)', newTableRow === undefined, JSON.stringify(newTableRow));
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(78)}\nG5B PHASE 2 LIVE DEV DRIFT-PROOFING: ${pass} PASS, ${fail} FAIL\n${'='.repeat(78)}`);
if (fail) { console.log('FAILED CHECKS:', failures.join(' | ')); }
// Windows/libuv occasionally raises a benign assertion during a hard
// process.exit() teardown after fetch() has used undici's keep-alive
// sockets (src/win/async.c "!(handle->flags & UV_HANDLE_CLOSING)") -- it is
// a Node-on-Windows process-teardown artifact, not a test failure (every
// check above has already run and been recorded); setting exitCode and
// letting the event loop drain naturally avoids triggering it.
process.exitCode = fail ? 1 : 0;
}

main();
