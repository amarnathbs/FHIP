// FDH-3 — RLS + FDH1-F1 tenant-referential-integrity + document/purge
// lifecycle certification against a freshly rebuilt database (PGlite/WASM),
// using REAL populated tenant data and genuine negative controls, following
// the exact standard established in scripts/fdh2_rls_certification.mjs
// (never a vacuous empty-table assertion).
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MIG = path.join(REPO, 'supabase', 'migrations');
const db = await PGlite.create();
await db.exec(fs.readFileSync(path.join(REPO, 'scripts', 'db-rebuild-check', 'shim.sql'), 'utf8'));
const seed = fs.readFileSync(path.join(REPO, 'supabase', 'seed.sql'), 'utf8');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
  if (f.startsWith('0001')) await db.exec(seed);
}
console.log(`fresh rebuild complete (${files.length} migrations)\n`);

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
async function asServiceRole(fn) {
  await db.exec(`reset role;`); // PGlite's default connection role already has bypassrls (superuser-equivalent)
  return fn();
}
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

// --- Seed one real document per tenant --------------------------------
let docA, docB;
await asServiceRole(async () => {
  const rowsA = await q(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code)
    values ('${A}', 'pdf_native', 'bank_statement', 'AU') returning id`);
  docA = rowsA[0].id;
  const rowsB = await q(`insert into fdh_statement_uploads (user_id, source_type, document_type, country_code)
    values ('${B}', 'pdf_native', 'bank_statement', 'AU') returning id`);
  docB = rowsB[0].id;
});
console.log(`seeded fdh_statement_uploads: A=${docA} B=${docB}\n`);

console.log('=== POSITIVE ACCESS: a tenant can create + read its own upload session ===');
let sessionA;
await asTenant(A, async () => {
  const rows = await q(`insert into fdh_upload_sessions (user_id, document_id, allowed_mime_type, expected_max_size_bytes, storage_key)
    values ('${A}', '${docA}', 'application/pdf', 1000000, '${A}/${docA}/${docA}.bin') returning id`);
  sessionA = rows[0]?.id;
  check('Tenant A can create its own upload session', Boolean(sessionA));
  const own = await q(`select count(*)::int c from fdh_upload_sessions where user_id = '${A}'`);
  check('Tenant A reads exactly its own session', own[0].c === 1, `(saw ${own[0].c})`);
});

console.log('\n=== TENANT ISOLATION: fdh_upload_sessions ===');
await asTenant(B, async () => {
  const leak = await q(`select count(*)::int c from fdh_upload_sessions where user_id = '${A}'`);
  check("Tenant B cannot read Tenant A's upload session", leak[0].c === 0, `(leaked ${leak[0].c})`);
});

console.log('\n=== FDH1-F1 HARDENING: cross-tenant document_id reference is refused (trigger, not just RLS) ===');
await asServiceRole(async () => {
  // A malicious/misconfigured write attempting to bind Tenant B's user_id to
  // Tenant A's document — an FK alone would allow this (docA genuinely
  // exists); only the FDH-3 trigger stops it.
  let blocked = false;
  try {
    await db.query(`insert into fdh_upload_sessions (user_id, document_id, allowed_mime_type, expected_max_size_bytes, storage_key)
      values ('${B}', '${docA}', 'application/pdf', 1000000, 'forged-key')`);
  } catch (e) { blocked = /cross-tenant/i.test(e.message); }
  check('cross-tenant fdh_upload_sessions.document_id reference is blocked by the FDH1-F1 trigger', blocked);
});
await asServiceRole(async () => {
  let blocked = false;
  try {
    await db.query(`insert into fdh_ingestion_jobs (user_id, statement_upload_id, job_type)
      values ('${B}', '${docA}', 'document_extract')`);
  } catch (e) { blocked = /cross-tenant/i.test(e.message); }
  check('cross-tenant fdh_ingestion_jobs.statement_upload_id reference is blocked by the FDH1-F1 trigger', blocked);
});
await asServiceRole(async () => {
  // Negative control: the SAME insert with the CORRECT owner must succeed —
  // proves the trigger checks OWNERSHIP, not merely "reject everything".
  const rows = await q(`insert into fdh_ingestion_jobs (user_id, statement_upload_id, job_type) values ('${A}', '${docA}', 'document_extract') returning id`);
  check('control: same-tenant fdh_ingestion_jobs insert succeeds (trigger is not simply blocking all writes)', Boolean(rows[0]?.id));
});

console.log('\n=== fdh_document_audit_events: owner-read-only, NO user-facing insert ===');
await asServiceRole(async () => {
  await q(`insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type)
    values ('${A}', '${docA}', 'document_upload_created', 'user'),
           ('${B}', '${docB}', 'document_upload_created', 'user')`);
});
await asTenant(A, async () => {
  const own = await q(`select count(*)::int c from fdh_document_audit_events where user_id = '${A}'`);
  check('Tenant A reads exactly its own audit event', own[0].c === 1, `(saw ${own[0].c})`);
  const leak = await q(`select count(*)::int c from fdh_document_audit_events where user_id = '${B}'`);
  check("Tenant A cannot read Tenant B's audit event", leak[0].c === 0, `(leaked ${leak[0].c})`);
  let insertBlocked = false;
  try {
    await db.query(`insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type) values ('${A}', '${docA}', 'document_purged', 'user')`);
  } catch (e) { insertBlocked = /policy|denied/i.test(e.message); }
  check('Tenant A CANNOT insert its own audit event directly (service-role only, per spec)', insertBlocked);
});

console.log('\n=== STORAGE RLS: fdh-source-documents bucket, SELECT-only, folder-scoped ===');
await asServiceRole(async () => {
  await q(`insert into storage.buckets (id, name, public) values ('fdh-source-documents', 'fdh-source-documents', false) on conflict (id) do nothing`);
  await q(`insert into storage.objects (bucket_id, name, owner) values
    ('fdh-source-documents', '${A}/${docA}/${docA}.bin', '${A}'),
    ('fdh-source-documents', '${B}/${docB}/${docB}.bin', '${B}')`);
});
await asTenant(A, async () => {
  const own = await q(`select count(*)::int c from storage.objects where bucket_id = 'fdh-source-documents' and (storage.foldername(name))[1] = '${A}'`);
  check('Tenant A can SELECT its own storage object', own[0].c === 1, `(saw ${own[0].c})`);
  const leak = await q(`select count(*)::int c from storage.objects where bucket_id = 'fdh-source-documents' and (storage.foldername(name))[1] = '${B}'`);
  check("Tenant A cannot SELECT Tenant B's storage object", leak[0].c === 0, `(leaked ${leak[0].c})`);
});
const bucketRow = await q(`select public from storage.buckets where id = 'fdh-source-documents'`);
check('the fdh-source-documents bucket is NOT public', bucketRow[0].public === false);

console.log('\n=== NEGATIVE CONTROLS (isolation deliberately removed -> leak MUST appear) ===');
await db.exec(`alter table fdh_upload_sessions disable row level security;`);
let sessLeak = 0;
await asTenant(B, async () => { sessLeak = (await q(`select count(*)::int c from fdh_upload_sessions where user_id='${A}'`))[0].c; });
check('control: RLS off on fdh_upload_sessions -> Tenant B DOES see Tenant A', sessLeak === 1, `(saw ${sessLeak}, expected 1)`);
await db.exec(`alter table fdh_upload_sessions enable row level security;`);
let sessRestored = 0;
await asTenant(B, async () => { sessRestored = (await q(`select count(*)::int c from fdh_upload_sessions where user_id='${A}'`))[0].c; });
check('control: isolation restored on fdh_upload_sessions', sessRestored === 0, `(saw ${sessRestored})`);

const noRls = await q(`select c.relname from pg_class c join pg_namespace nsp on nsp.oid=c.relnamespace
  where nsp.nspname='public' and c.relkind='r' and not c.relrowsecurity
  and c.relname in ('fdh_upload_sessions','fdh_document_audit_events') order by 1`);
check('both FDH-3 tables have RLS enabled', noRls.length === 0, `(${noRls.length} without RLS)`);

console.log('\n=== DOCUMENT + PURGE LIFECYCLE (state machine, exercised against real rows) ===');
await asServiceRole(async () => {
  await q(`update fdh_statement_uploads set processing_status='uploaded' where id='${docA}'`);
  const r1 = await q(`select processing_status from fdh_statement_uploads where id='${docA}'`);
  check('document A: created -> uploaded persisted', r1[0].processing_status === 'uploaded');

  await q(`update fdh_statement_uploads set processing_status='approved', approved_at=now(), raw_document_storage_reference='${A}/${docA}/${docA}.bin' where id='${docA}'`);
  await q(`update fdh_statement_uploads set raw_document_purge_status='pending', raw_document_purge_due_at=now() where id='${docA}'`);
  await q(`update fdh_statement_uploads set raw_document_purge_status='in_progress' where id='${docA}'`);
  await q(`update fdh_statement_uploads set raw_document_purge_status='purged', raw_document_purged_at=now(), raw_document_storage_reference=null, original_filename_sanitised=null where id='${docA}'`);
  const r2 = await q(`select raw_document_purge_status, raw_document_storage_reference from fdh_statement_uploads where id='${docA}'`);
  check('purge lifecycle: pending -> in_progress -> purged, storage reference nulled', r2[0].raw_document_purge_status === 'purged' && r2[0].raw_document_storage_reference === null);

  let blocked = false;
  try { await db.query(`update fdh_statement_uploads set raw_document_purge_status='purged', raw_document_storage_reference='still-here' where id='${docA}'`); }
  catch (e) { blocked = /constraint|check/i.test(e.message); }
  check('DB constraint refuses purged=true while a storage reference is still present', blocked);
});

console.log(`\n=== FDH-3 RLS + LIFECYCLE CERTIFICATION: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
