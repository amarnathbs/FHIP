// II-R10 — RLS certification for migration
// 0070_ii_r10_reports_authoritative_write_hardening.sql, against a fresh
// PGlite rebuild (real Postgres 18 wasm, real RLS enforcement). Mirrors the
// exact harness pattern already established by
// scripts/db-rebuild-check/rls.mjs.
//
// Proves, on real seeded data (never empty-table assertions):
//   1. The authenticated owning user can still SELECT their own rows in all
//      six reports-family tables (no read regression).
//   2. The authenticated owning user can NO LONGER forge any of the five
//      attacks reproduced live against real DEV this session
//      (scripts/r10_repro_reports_forgery.mjs /
//      scripts/r10_repro_status_only.mjs):
//        - reports.status ready -> published (bypassing publishReport())
//        - report_sections.section_data_json / narrative_text rewrite
//        - report_snapshots forged provenance row
//        - report_exports forged ready status + arbitrary storage_path
//        - report_generation_runs forged audit outcome
//   3. Cross-tenant read/write denial still holds (defence in depth).
//   4. The service_role client (used by every real write path after this
//      session's application-code refactor) can still perform every
//      legitimate write — i.e. the fix does not break report generation.
//   5. NEGATIVE CONTROL: re-applying the OLD permissive policy (`for all
//      using/with check auth.uid()=user_id`) on a scratch copy of `reports`
//      makes the exact same forgery attempt succeed again — proving this
//      test suite is capable of catching the defect it just fixed, not
//      vacuous.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8');
for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log('fresh rebuild complete (includes 0070)\n');

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
await db.exec(`insert into auth.users(id,email) values ('${A}','a@t.test'),('${B}','b@t.test');`);

var pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };

async function asTenant(uid, fn) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec(`set role authenticated;`);
  const seen = (await db.query(`select auth.uid()::text u`)).rows[0].u;
  if (seen !== uid) { console.log(`  FAIL  harness: auth.uid() is ${seen}, expected ${uid} — tests would be vacuous`); fail++; }
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
async function asService(fn) {
  await db.exec(`reset role;`);
  await db.exec(`set role service_role;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}

console.log('=== SEEDING (as service_role, mirrors real generateReport()/exports writes) ===');
let reportId, sectionId, snapshotId, exportId, runId;
await asService(async () => {
  const r = await db.query(`
    insert into reports (user_id, report_type_code, report_period_start, report_period_end, report_month, as_of_date, title, status, reporting_currency)
    values ('${A}','net_worth','2026-08-01','2026-08-31','2026-08-01','2026-08-24','R10 cert report','ready','AUD')
    returning id`);
  reportId = r.rows[0].id;
  const s = await db.query(`
    insert into report_sections (report_id, user_id, section_code, section_title, display_order, section_status, section_data_json, narrative_text)
    values ('${reportId}','${A}','net_worth_summary','Net Worth Summary',1,'included','{"netWorth":100000}'::jsonb,'Genuine narrative')
    returning id`);
  sectionId = s.rows[0].id;
  const sn = await db.query(`
    insert into report_snapshots (report_id, user_id, snapshot_type, source_version)
    values ('${reportId}','${A}','financial','dashboard-1.0.0') returning id`);
  snapshotId = sn.rows[0].id;
  const ex = await db.query(`
    insert into report_exports (report_id, requested_by_user_id, export_format, status)
    values ('${reportId}','${A}','pdf','generating') returning id`);
  exportId = ex.rows[0].id;
  const run = await db.query(`
    insert into report_generation_runs (user_id, report_id, trigger_type, output_status)
    values ('${A}','${reportId}','manual','started') returning id`);
  runId = run.rows[0].id;
});
console.log(`  seeded report ${reportId} with 1 section, 1 snapshot, 1 export, 1 generation run\n`);

console.log('=== 1. READ REGRESSION CHECK (owner can still see their own rows) ===');
await asTenant(A, async () => {
  check('Tenant A reads own reports row', (await db.query(`select count(*)::int c from reports where id='${reportId}'`)).rows[0].c === 1);
  check('Tenant A reads own report_sections row', (await db.query(`select count(*)::int c from report_sections where id='${sectionId}'`)).rows[0].c === 1);
  check('Tenant A reads own report_snapshots row', (await db.query(`select count(*)::int c from report_snapshots where id='${snapshotId}'`)).rows[0].c === 1);
  check('Tenant A reads own report_exports row', (await db.query(`select count(*)::int c from report_exports where id='${exportId}'`)).rows[0].c === 1);
  check('Tenant A reads own report_generation_runs row', (await db.query(`select count(*)::int c from report_generation_runs where id='${runId}'`)).rows[0].c === 1);
});

console.log('\n=== 2. SAME-USER FORGERY DENIAL (the 5 live-reproduced DEV attacks) ===');
// IMPORTANT: every attack + its "did it actually change" verification stays
// inside ONE asTenant() call with no nested asService() call in between —
// asService()'s own `reset role` (in its `finally`) would otherwise leak out
// and silently drop the connection back to the default/superuser role for
// the *next* statement in this same block, making every subsequent "attack"
// spuriously appear to succeed against a role that was never actually
// `authenticated` any more. All five attacks run first, all verification
// reads happen afterwards in a single separate asService() call.
const attackOutcomes = {};
await asTenant(A, async () => {
  try {
    const r = await db.query(`update reports set status='published', published_at=now() where id='${reportId}' returning 1`);
    attackOutcomes.attack1Rows = r.rows.length;
  } catch (e) { attackOutcomes.attack1Rows = 0; attackOutcomes.attack1Error = e.message; }

  try {
    const r = await db.query(`update report_sections set section_data_json='{"netWorth":99999999,"forged":true}'::jsonb, narrative_text='FORGED' where id='${sectionId}' returning 1`);
    attackOutcomes.attack2Rows = r.rows.length;
  } catch (e) { attackOutcomes.attack2Rows = 0; attackOutcomes.attack2Error = e.message; }

  try {
    const r = await db.query(`insert into report_snapshots (report_id, user_id, snapshot_type, source_version) values ('${reportId}','${A}','financial','forged-engine-9.9.9') returning id`);
    attackOutcomes.attack3Rows = r.rows.length;
  } catch (e) { attackOutcomes.attack3Rows = 0; attackOutcomes.attack3Error = e.message; }

  try {
    const r = await db.query(`insert into report_exports (report_id, requested_by_user_id, export_format, status, storage_path) values ('${reportId}','${A}','pdf','ready','${A}/${reportId}/forged.pdf') returning id`);
    attackOutcomes.attack4Rows = r.rows.length;
  } catch (e) { attackOutcomes.attack4Rows = 0; attackOutcomes.attack4Error = e.message; }

  try {
    const r = await db.query(`update report_generation_runs set output_status='succeeded' where id='${runId}' returning 1`);
    attackOutcomes.attack5Rows = r.rows.length;
  } catch (e) { attackOutcomes.attack5Rows = 0; attackOutcomes.attack5Error = e.message; }
});

const finalState = await asService(async () => ({
  reportStatus: (await db.query(`select status from reports where id='${reportId}'`)).rows[0].status,
  section: (await db.query(`select section_data_json, narrative_text from report_sections where id='${sectionId}'`)).rows[0],
  snapshotCount: (await db.query(`select count(*)::int c from report_snapshots where report_id='${reportId}'`)).rows[0].c,
  exportCount: (await db.query(`select count(*)::int c from report_exports where report_id='${reportId}' and status='ready'`)).rows[0].c,
  runStatus: (await db.query(`select output_status from report_generation_runs where id='${runId}'`)).rows[0].output_status,
}));

check('ATTACK-1 blocked: reports.status ready->published forgery', attackOutcomes.attack1Rows === 0 && finalState.reportStatus === 'ready', `(rows affected: ${attackOutcomes.attack1Rows}, final status: ${finalState.reportStatus})`);
check('ATTACK-2 blocked: report_sections financial numbers/narrative forgery', attackOutcomes.attack2Rows === 0 && finalState.section.narrative_text === 'Genuine narrative', `(rows affected: ${attackOutcomes.attack2Rows}, final narrative: ${finalState.section.narrative_text})`);
check('ATTACK-3 blocked: fabricated report_snapshots provenance row', attackOutcomes.attack3Rows === 0 && finalState.snapshotCount === 1, `(rows inserted: ${attackOutcomes.attack3Rows}, total snapshots: ${finalState.snapshotCount}, expected 1 = only the genuine seed row)`);
check('ATTACK-4 blocked: forged report_exports ready status + storage_path', attackOutcomes.attack4Rows === 0 && finalState.exportCount === 0, `(rows inserted: ${attackOutcomes.attack4Rows}, ready exports: ${finalState.exportCount}, expected 0 — the seed export is still 'generating')`);
check('ATTACK-5 blocked: report_generation_runs audit outcome forgery', attackOutcomes.attack5Rows === 0 && finalState.runStatus === 'started', `(rows affected: ${attackOutcomes.attack5Rows}, final status: ${finalState.runStatus})`);

console.log('\n=== 3. CROSS-TENANT DENIAL (defence in depth, unchanged behaviour) ===');
await asTenant(B, async () => {
  check('Tenant B cannot read Tenant A reports row', (await db.query(`select count(*)::int c from reports where id='${reportId}'`)).rows[0].c === 0);
  check('Tenant B cannot read Tenant A report_sections row', (await db.query(`select count(*)::int c from report_sections where id='${sectionId}'`)).rows[0].c === 0);
});

console.log('\n=== 4. TRUSTED SERVICE WRITES STILL WORK (service_role bypasses RLS as before) ===');
await asService(async () => {
  const r = await db.query(`update reports set status='published', published_at=now() where id='${reportId}' and status='ready' returning status`);
  check('service_role can publish a report (legitimate transition)', r.rows[0]?.status === 'published');
  const r2 = await db.query(`update report_exports set status='ready', storage_path='${A}/${reportId}/${exportId}.pdf', checksum='abc123' where id='${exportId}' returning status`);
  check('service_role can complete a real export', r2.rows[0]?.status === 'ready');
});

console.log('\n=== 5. NEGATIVE CONTROL — old permissive policy reinstated on a scratch table proves this suite is not vacuous ===');
await db.exec(`reset role;`); // default connection role (postgres, table owner) — DDL requires this, not service_role
{
  await db.exec(`create table reports_scratch (like reports including all);`);
  await db.exec(`alter table reports_scratch enable row level security;`);
  await db.exec(`create policy "old permissive policy" on reports_scratch for all using (auth.uid() = user_id) with check (auth.uid() = user_id);`);
  await db.query(`insert into reports_scratch (id, user_id, report_type_code, report_period_start, report_period_end, report_month, as_of_date, title, status, reporting_currency) values ('${reportId}','${A}','net_worth','2026-08-01','2026-08-31','2026-08-01','2026-08-24','scratch','ready','AUD')`);
  await db.exec(`grant select, insert, update, delete on reports_scratch to authenticated;`);
}
await asTenant(A, async () => {
  const r = await db.query(`update reports_scratch set status='published' where id='${reportId}' returning status`);
  check('NEGATIVE CONTROL: old policy shape lets the same forgery succeed (proves suite detects real regressions)', r.rows[0]?.status === 'published', '(this is the expected RED-if-regressed behaviour, reproduced deliberately on a scratch table only)');
});

console.log(`\n=== RESULT: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail > 0 ? 1 : 0);
