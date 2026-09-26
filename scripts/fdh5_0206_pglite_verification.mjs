// FDH-5 -- PGlite verification for migration 0206 (catch-up of the parts of
// 0071 production never received).
//
// Case A: a full replay (0071 applied) -- 0206 must change nothing.
// Case B: a production-shaped database -- the full chain replayed, then 0071's
//   additive parts removed exactly as production lacks them (3 upload columns,
//   the parser-versions column + check, the 8 PDF registry/version rows, and
//   the trigger body put back to 0065's). The anti-vacuity checks prove the
//   gap is real before 0206 runs.
// Both cases: the two shared CHECK constraints 0071 would have dropped and
// recreated (error_code, audit event_type) must be byte-identical before and
// after 0206, and a second apply must be a clean no-op.
//
// Run: node scripts/fdh5_0206_pglite_verification.mjs

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + e.message); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e?.message || e)); process.exit(9); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'supabase');
const MIG = path.join(ROOT, 'migrations');
const TARGET = '0206_fdh5_bank_pdf_schema_catchup.sql';
const strip = (s) => s.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const target = strip(fs.readFileSync(path.join(MIG, TARGET), 'utf8'));

async function replayUpToTarget() {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(HERE, 'db-rebuild-check', 'shim.sql'), 'utf8'));
  for (const f of files) {
    if (f >= TARGET) break;
    await db.exec(strip(fs.readFileSync(path.join(MIG, f), 'utf8')));
    if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(ROOT, 'seed.sql'), 'utf8'));
  }
  return db;
}

/** 0065's body of the trigger function (what production still runs). */
function body0065() {
  const src = fs.readFileSync(path.join(MIG, files.find((f) => f.startsWith('0065_'))), 'utf8');
  const start = src.indexOf('create or replace function r7_assert_statement_upload_authoritative_fields');
  const end = src.indexOf('$$ language plpgsql', start);
  return src.slice(start, src.indexOf(';', end) + 1);
}

const one = async (db, sql) => (await db.query(sql)).rows[0];
const cols = async (db, table) => (await db.query(`select column_name from information_schema.columns where table_name = '${table}'`)).rows.map((r) => r.column_name);
const constraintDef = async (db, table, name) => (await one(db, `select pg_get_constraintdef(oid) d from pg_constraint where conrelid = '${table}'::regclass and conname = '${name}'`))?.d ?? null;
const sharedDefs = async (db) => ({
  errorCode: await constraintDef(db, 'fdh_statement_uploads', 'fdh_statement_uploads_error_code_check'),
  eventType: await constraintDef(db, 'fdh_document_audit_events', 'fdh_document_audit_events_event_type_check'),
});
const pdfRegistry = async (db) => (await one(db, `select count(*)::int n from fdh_parser_registry where parser_key like '%\\_pdf\\_v1' escape '\\'`)).n;
const pdfVersions = async (db) => (await one(db, `select count(*)::int n from fdh_parser_versions pv join fdh_parser_registry r on r.id = pv.parser_id where r.parser_key like '%\\_pdf\\_v1' escape '\\' and pv.version = '1.0.0'`)).n;
const fnBody = async (db) => (await one(db, `select prosrc from pg_proc where proname = 'r7_assert_statement_upload_authoritative_fields'`)).prosrc;
const uploadChecks = async (db) => (await db.query(`select pg_get_constraintdef(oid) d from pg_constraint where conrelid = 'fdh_statement_uploads'::regclass and contype = 'c'`)).rows.map((r) => r.d);

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`);
};

// ---------------- Case A: full replay, 0071 present -> 0206 changes nothing ----------------
{
  console.log('Case A -- full replay (0071 applied)');
  const db = await replayUpToTarget();
  const before = { cols: await cols(db, 'fdh_statement_uploads'), checks: (await uploadChecks(db)).sort(), shared: await sharedDefs(db), reg: await pdfRegistry(db), ver: await pdfVersions(db), fn: await fnBody(db) };
  check('anti-vacuity: 0071 really is applied here (page_count exists, 8 PDF parsers)', before.cols.includes('page_count') && before.reg === 8, `pdf registry rows: ${before.reg}`);
  await db.exec(target);
  const after = { cols: await cols(db, 'fdh_statement_uploads'), checks: (await uploadChecks(db)).sort(), shared: await sharedDefs(db), reg: await pdfRegistry(db), ver: await pdfVersions(db), fn: await fnBody(db) };
  check('no duplicate CHECK constraints added to fdh_statement_uploads', JSON.stringify(after.checks) === JSON.stringify(before.checks), `${before.checks.length} -> ${after.checks.length}`);
  check('no duplicate PDF registry or version rows', after.reg === 8 && after.ver === before.ver, `registry ${after.reg}, versions ${before.ver} -> ${after.ver}`);
  check('error_code and audit event_type constraints byte-identical', JSON.stringify(after.shared) === JSON.stringify(before.shared));
  check('trigger body unchanged (0071 body already current)', after.fn.trim() === before.fn.trim());
}

// ---------------- Case B: production-shaped (0071 parts missing) ----------------
{
  console.log('Case B -- production-shaped: 0071 parts removed');
  const db = await replayUpToTarget();
  await db.exec(body0065());
  await db.exec(`
    delete from fdh_parser_versions where parser_id in (select id from fdh_parser_registry where parser_key like '%\\_pdf\\_v1' escape '\\');
    delete from fdh_parser_registry where parser_key like '%\\_pdf\\_v1' escape '\\';
    alter table fdh_parser_versions drop constraint if exists chk_fdh_parser_versions_extraction_methods;
    alter table fdh_parser_versions drop column certified_extraction_methods;
    alter table fdh_statement_uploads drop column page_count, drop column pdf_classification, drop column extraction_confidence;
  `);
  const sharedBefore = await sharedDefs(db);
  const colsBefore = await cols(db, 'fdh_statement_uploads');
  check('anti-vacuity: the production gap is real (no page_count / pdf_classification / extraction_confidence, 0 PDF parsers)',
    !colsBefore.includes('page_count') && !colsBefore.includes('pdf_classification') && !colsBefore.includes('extraction_confidence') && (await pdfRegistry(db)) === 0);
  let failedBefore = null;
  try { await db.exec(`update fdh_statement_uploads set page_count = 1 where false`); } catch (e) { failedBefore = e.message; }
  check('anti-vacuity: the production failure reproduces (writing page_count errors before 0206)', failedBefore !== null, failedBefore ?? 'no error');

  await db.exec(target);
  const colsAfter = await cols(db, 'fdh_statement_uploads');
  check('the three columns now exist', ['page_count', 'pdf_classification', 'extraction_confidence'].every((c) => colsAfter.includes(c)));
  let wrote = null;
  try { await db.exec(`update fdh_statement_uploads set page_count = 1, pdf_classification = 'text_native', extraction_confidence = 0.5 where false`); } catch (e) { wrote = e.message; }
  check('the final-status write that failed in production now succeeds', wrote === null, wrote ?? '');
  const rejects = async (sql) => { try { await db.exec(sql); return false; } catch { return true; } };
  await db.exec(`insert into auth.users(id, email) values ('11111111-1111-1111-1111-111111111111', 'x@t.test') on conflict do nothing`);
  // The country gate (MCC) refuses FDH writes for an unconfirmed user -- confirm, as the 0196/0197 checks do.
  await db.exec(`update user_profiles set country_of_residence='AU', country_confirmed_at=now(), country_source='USER_CONFIRMED' where user_id='11111111-1111-1111-1111-111111111111'`);
  const probe = `insert into fdh_statement_uploads (id, user_id, source_type, document_type, country_code, currency_code, processing_status) values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'pdf_native', 'bank_statement', 'AU', 'AUD', 'queued')`;
  let probeErr = null; try { await db.exec(probe); } catch (e) { probeErr = e.message; }
  check('setup: a probe upload row exists', probeErr === null, probeErr ?? '');
  check("0071's checks are enforced: page_count 0 refused", await rejects(`update fdh_statement_uploads set page_count = 0 where id = '22222222-2222-2222-2222-222222222222'`));
  check("0071's checks are enforced: unknown pdf_classification refused", await rejects(`update fdh_statement_uploads set pdf_classification = 'bogus' where id = '22222222-2222-2222-2222-222222222222'`));
  check("0071's checks are enforced: extraction_confidence 1.5 refused", await rejects(`update fdh_statement_uploads set extraction_confidence = 1.5 where id = '22222222-2222-2222-2222-222222222222'`));
  check('fdh_parser_versions.certified_extraction_methods restored with its check', (await cols(db, 'fdh_parser_versions')).includes('certified_extraction_methods') && (await constraintDef(db, 'fdh_parser_versions', 'chk_fdh_parser_versions_extraction_methods')) !== null);
  check('the 8 PDF parser registry rows and their 1.0.0 versions restored', (await pdfRegistry(db)) === 8 && (await pdfVersions(db)) === 8, `registry ${await pdfRegistry(db)}, versions ${await pdfVersions(db)}`);
  check('trigger body now guards the three FDH-5 columns', (await fnBody(db)).includes('new.page_count is distinct from old.page_count'));
  // The trigger in action: an authenticated owner may not write an authoritative FDH-5 field.
  await db.exec(`set request.jwt.claim.role = 'authenticated'`);
  const authBlocked = await rejects(`update fdh_statement_uploads set page_count = 3 where id = '22222222-2222-2222-2222-222222222222'`);
  await db.exec(`reset request.jwt.claim.role`);
  check('an authenticated caller cannot set page_count directly (trigger enforced)', authBlocked);
  check('error_code and audit event_type constraints byte-identical before/after (0071 would have narrowed them)', JSON.stringify(await sharedDefs(db)) === JSON.stringify(sharedBefore));

  const checksOnce = (await uploadChecks(db)).sort();
  let reErr = null; try { await db.exec(target); } catch (e) { reErr = e.message; }
  check('re-applying 0206 is a clean no-op', reErr === null && JSON.stringify((await uploadChecks(db)).sort()) === JSON.stringify(checksOnce) && (await pdfRegistry(db)) === 8 && (await pdfVersions(db)) === 8, reErr ?? '');
}

console.log(`\n=== FDH-5 / 0206 PGlite verification: ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
