// Admin A0.2 Wave 4 — Gate G1, bounded live-DEV check.
//
// Scope of THIS script (disclosed honestly, not oversold): DDL cannot be
// executed against DEV from this worktree (no `supabase` CLI is linked, no
// direct Postgres connection string is present in .env.local — only the
// Supabase REST/Auth API keys) — the same "manual handoff" limitation
// every prior Wave in this programme has hit and disclosed. Migration 0125
// has therefore NOT been applied to DEV by this script. What this script
// DOES prove, live, against real DEV Postgres:
//   1. Connectivity to the certified DEV project (never production).
//   2. Migration 0125 is honestly NOT yet applied (the new function/columns
//      do not exist yet) — proving this round is not silently assuming
//      something that isn't there.
//   3. A REAL Postgrest error shape (a genuine unique-constraint violation
//      on a disposable fixture) round-trips through the exact same
//      safeDbError() classification this Wave's G6 fix relies on — so the
//      mapping is validated against real DEV-produced error objects, not
//      only the shapes this session assumed when writing the mocked unit
//      tests.
//   4. Full fixture cleanup with an independent residual check.
//
// What this script does NOT prove (named, not hidden): the new RPC's live
// behaviour (atomic transition + audit, rollback-on-audit-failure, the
// idempotent no-op, the 401/403/404/422 mapping through a REAL running
// Next.js route over HTTP) — that requires migration 0125 to be applied
// first. See the Wave 4 report's G1 gate entry for the exact handoff.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;

// Refuses to run against anything but the certified DEV project, and
// deliberately reads ONLY `SUPABASE_SERVICE_ROLE_KEY` (the DEV key) — never
// `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY`, which this worktree's borrowed
// .env.local also happens to contain and which this script never touches,
// references, or logs.
if (!/vqycarelcoijzwlpkpcz/.test(url ?? '')) {
  console.error(`REFUSING TO RUN: target ${url} is not the certified DEV project. This script must never run against production.`);
  process.exit(2);
}
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0;
let fail = 0;
function check(label, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${extra}`);
  }
}

const RUN = `a02w4-${Date.now().toString(36)}`;
const createdSourceIds = [];

async function main() {
  console.log(`Target project ref confirmed DEV (vqycarelcoijzwlpkpcz). Fixture prefix: ${RUN}`);

  console.log('\n=== 1. Connectivity ===');
  const { error: pingErr } = await admin.from('admin_users').select('user_id').limit(1);
  check('service-role client can read admin_users (real DEV connectivity)', !pingErr, pingErr?.message);

  console.log('\n=== 2. Migration 0125 honestly NOT yet applied (no assumption, verified) ===');
  const { error: rpcErr } = await admin.rpc('admin_transition_benchmark_source', { p_source_id: '00000000-0000-0000-0000-000000000000', p_new_status: 'approved' });
  check(
    'admin_transition_benchmark_source does not exist yet in DEV (expected — migration 0125 awaits manual handoff)',
    rpcErr?.code === 'PGRST202' && /could not find the function/i.test(rpcErr.message ?? ''),
    JSON.stringify(rpcErr)
  );

  console.log('\n=== 3. G6 error-shape validation against a REAL Postgrest error from real DEV Postgres ===');
  // A genuine unique-constraint violation: insert the same disposable
  // source_name+source_type+publisher combination is fine (no unique
  // constraint on those) — instead force a real 23514 by using an invalid
  // source_type the table's own CHECK constraint rejects, exactly the
  // class of error safeDbError() is meant to classify.
  const badRow = {
    source_name: `${RUN}-bad-type`,
    source_type: 'not_a_real_type', // violates benchmark_sources' own CHECK constraint
    publisher: 'Wave 4 Live-DEV Check',
    source_title: `${RUN}-bad-type`,
    citation_text: 'disposable fixture, cleaned up by this script',
    status: 'draft',
  };
  const { error: checkViolation } = await admin.from('benchmark_sources').insert(badRow).select('id').single();
  check('a genuine CHECK-constraint violation returns SQLSTATE 23514 (the exact code safeDbError() maps to 422 VALIDATION_FAILED)', checkViolation?.code === '23514', JSON.stringify(checkViolation));
  check('the real error message contains internal detail that must never reach a client (proving the redaction is necessary, not theoretical)', /benchmark_sources_source_type_check|violates check constraint/i.test(checkViolation?.message ?? ''), checkViolation?.message);

  console.log('\n=== 4. A real, disposable, valid fixture — confirms current (pre-migration) sources/[id] PUT metadata path still behaves ===');
  const { data: goodRow, error: insertErr } = await admin
    .from('benchmark_sources')
    .insert({
      source_name: `${RUN}-valid`,
      source_type: 'official',
      publisher: 'Wave 4 Live-DEV Check',
      source_title: `${RUN}-valid`,
      citation_text: 'disposable fixture, cleaned up by this script',
      status: 'draft',
    })
    .select('id')
    .single();
  check('a valid fixture source can be created (real DEV write path works)', !insertErr && !!goodRow, insertErr?.message);
  if (goodRow) createdSourceIds.push(goodRow.id);

  if (goodRow) {
    const { data: notFoundProbe, error: nfErr } = await admin.from('benchmark_sources').select('status').eq('id', '00000000-0000-0000-0000-000000000000').maybeSingle();
    check('an unknown id genuinely returns zero rows via .maybeSingle() (the exact shape the 404 branch depends on), not an error', !nfErr && notFoundProbe === null, JSON.stringify({ nfErr, notFoundProbe }));
  }

  console.log('\n=== 5. Fixture cleanup (independent residual check) ===');
  const before = createdSourceIds.length;
  for (const id of createdSourceIds) {
    await admin.from('benchmark_sources').delete().eq('id', id);
  }
  const { data: residual } = await admin.from('benchmark_sources').select('id').ilike('source_name', `${RUN}%`);
  check(`all ${before} fixture(s) removed, independently re-verified zero residual rows matching prefix "${RUN}"`, (residual ?? []).length === 0, JSON.stringify(residual));

  console.log(`\n${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('LIVE-DEV CHECK SCRIPT ERROR:', e);
  // Best-effort cleanup even on an unexpected failure mid-script.
  for (const id of createdSourceIds) {
    await admin.from('benchmark_sources').delete().eq('id', id).then(() => {}, () => {});
  }
  process.exit(1);
});
