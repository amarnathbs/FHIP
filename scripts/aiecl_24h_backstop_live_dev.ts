/**
 * AIE-1 infrastructure-activation follow-on -- live-DEV proof of the
 * Product Owner's own named concern: "a user who never accepts could
 * leave the PDF retained until cleanup; that limit must be implemented
 * and verified." lib/aie/services/purge.ts#enforceAieRawFileHardBackstop
 * is the existing, adapter-agnostic, age-based mechanism that closes this
 * -- implemented before this session, unit-tested, but never live-DEV
 * verified because migration 0149's purge_status/purge_due_at columns
 * did not exist in DEV until just now (confirmed empirically this
 * session: a direct column read failed with "column ... does not exist"
 * before 0149 was applied).
 *
 * Creates a real, genuinely-aged (created_at backdated 25 hours), never-
 * accepted intake row pointing at a REAL object in AIE quarantine
 * storage, proves the backstop finds and schedules it, then proves the
 * sweep genuinely deletes the real storage object -- alongside a negative
 * control (a fresh, NOT-yet-aged row) proving the age filter is real, not
 * a rubber stamp that would sweep everything regardless of age.
 *
 * Run: npx tsx scripts/aiecl_24h_backstop_live_dev.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(__dirname, '..');
function loadEnv() {
  const raw = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').replace(/^﻿/, '');
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let passed = 0, failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}` + (detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 1000)}` : '')); }
}

const BUCKET = 'aie-document-quarantine';

async function main() {
  // Import AFTER env vars are set (lib/supabase/admin.ts reads process.env at call time, but some modules read at import time).
  const { enforceAieRawFileHardBackstop, findDuePurges, runPurgeAttempt } = await import('../lib/aie/services/purge');

  const stamp = Date.now();
  const email = `aiecl-backstop-${stamp}@example.com`;
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  let userId = '';
  let agedIntakeId = '';
  let freshIntakeId = '';
  const agedKey = `${stamp}/aged-backstop-test/aged.bin`;
  const freshKey = `${stamp}/aged-backstop-test/fresh.bin`;

  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`create user failed: ${created.error?.message}`);
    userId = created.data.user.id;

    // Real objects in the real quarantine bucket -- not a DB-only fixture.
    // application/pdf, since the bucket's own MIME allowlist (Supabase
    // Storage bucket config, not a migration file) rejects
    // application/octet-stream -- confirmed live, not assumed.
    const bytes = new TextEncoder().encode('%PDF-1.4 synthetic AIE 24h-backstop test content, not a real document');
    const upAged = await admin.storage.from(BUCKET).upload(agedKey, bytes, { contentType: 'application/pdf' });
    check('setup: real object uploaded to quarantine for the AGED row', !upAged.error, upAged.error?.message);
    const upFresh = await admin.storage.from(BUCKET).upload(freshKey, bytes, { contentType: 'application/pdf' });
    check('setup: real object uploaded to quarantine for the FRESH (negative-control) row', !upFresh.error, upFresh.error?.message);

    // AGED row: created_at backdated 25 hours -- simulates "extraction
    // finished, user never accepted, well past the 24h hard limit."
    // status='ready' -- the actual allowed vocabulary for
    // aie_document_intake.status is ('received','quarantined','rejected',
    // 'ready','cancelled','deleted'); 'awaiting_acceptance' is a RUN
    // status (aie_extraction_run), not an intake-row status -- confirmed
    // live via the table's own check constraint after an initial wrong
    // guess.
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const agedIntake = await admin.from('aie_document_intake').insert({
      user_id: userId, declared_mime_type: 'application/pdf', byte_size: bytes.byteLength,
      storage_key: agedKey, status: 'ready', created_at: twentyFiveHoursAgo,
    }).select('id, created_at').single();
    // Compare as Date values, not strings -- PostgREST reformats the
    // timestamp's textual representation on round-trip (e.g. "+00:00" vs
    // "Z", trailing-zero milliseconds), which is not a defect, just a
    // serialization difference; the actual instant must match exactly.
    const storedCreatedAtMs = agedIntake.data ? new Date(agedIntake.data.created_at).getTime() : NaN;
    check('setup: aged intake row created with created_at genuinely 25h in the past', !agedIntake.error && storedCreatedAtMs === new Date(twentyFiveHoursAgo).getTime(), agedIntake.error?.message ?? agedIntake.data);
    agedIntakeId = agedIntake.data!.id;

    // FRESH row: created_at = now(). Negative control -- must NOT be
    // touched by the backstop, proving the age filter is real.
    const freshIntake = await admin.from('aie_document_intake').insert({
      user_id: userId, declared_mime_type: 'application/pdf', byte_size: bytes.byteLength,
      storage_key: freshKey, status: 'ready',
    }).select('id').single();
    check('setup: fresh (not-aged) negative-control intake row created', !freshIntake.error, freshIntake.error?.message);
    freshIntakeId = freshIntake.data!.id;

    // --- Run the actual backstop ------------------------------------
    const backstopResult = await enforceAieRawFileHardBackstop(24 * 60, 200);
    check('backstop scan ran without error', true);
    console.log('backstop result:', JSON.stringify(backstopResult));

    const agedAfterScan = await admin.from('aie_document_intake').select('purge_status, purge_reason, purge_due_at').eq('id', agedIntakeId).single();
    check('AGED row was scheduled for purge (purge_status=pending, reason=hard backstop)', agedAfterScan.data?.purge_status === 'pending' && agedAfterScan.data?.purge_reason === 'raw_retention_hard_backstop_24h', agedAfterScan.data);

    const freshAfterScan = await admin.from('aie_document_intake').select('purge_status').eq('id', freshIntakeId).single();
    check('NEGATIVE CONTROL: fresh row was NOT touched by the backstop (age filter is real)', freshAfterScan.data?.purge_status !== 'pending', freshAfterScan.data);

    // --- Run the actual sweep on what the backstop scheduled ---------
    const due = await findDuePurges(50);
    const agedDue = due.find((r) => r.id === agedIntakeId);
    check('the aged row is genuinely due for purge per findDuePurges()', !!agedDue, due.map((r) => r.id));

    if (agedDue) {
      const attempt = await runPurgeAttempt(agedDue);
      check('purge attempt on the aged row reports "purged"', attempt.status === 'purged', attempt);
    }

    const agedAfterSweep = await admin.from('aie_document_intake').select('status, purge_status, storage_key, purged_at').eq('id', agedIntakeId).single();
    check('aged row: status flipped to deleted, purge_status=purged, storage_key cleared', agedAfterSweep.data?.status === 'deleted' && agedAfterSweep.data?.purge_status === 'purged' && agedAfterSweep.data?.storage_key === null, agedAfterSweep.data);

    const agedObjectListing = await admin.storage.from(BUCKET).list(`${stamp}/aged-backstop-test`, { search: 'aged.bin' });
    const agedStillPresent = (agedObjectListing.data ?? []).some((f) => f.name === 'aged.bin');
    check('the real storage object for the aged row was genuinely deleted', !agedStillPresent, agedObjectListing.data);

    const freshObjectListing = await admin.storage.from(BUCKET).list(`${stamp}/aged-backstop-test`, { search: 'fresh.bin' });
    const freshStillPresent = (freshObjectListing.data ?? []).some((f) => f.name === 'fresh.bin');
    check('NEGATIVE CONTROL: the fresh row\'s real storage object is untouched (still present)', freshStillPresent, freshObjectListing.data);
  } finally {
    // Cleanup: delete rows + any surviving storage objects + the user.
    if (agedIntakeId) await admin.from('aie_document_intake').delete().eq('id', agedIntakeId);
    if (freshIntakeId) await admin.from('aie_document_intake').delete().eq('id', freshIntakeId);
    await admin.storage.from(BUCKET).remove([agedKey, freshKey]); // no-op for the already-deleted aged object
    if (userId) await admin.auth.admin.deleteUser(userId);

    const residueAged = agedIntakeId ? await admin.from('aie_document_intake').select('id').eq('id', agedIntakeId).maybeSingle() : { data: null };
    const residueFresh = freshIntakeId ? await admin.from('aie_document_intake').select('id').eq('id', freshIntakeId).maybeSingle() : { data: null };
    const residueUser = userId ? await admin.auth.admin.getUserById(userId) : { data: { user: null } };
    const residueFreshObject = await admin.storage.from(BUCKET).list(`${stamp}/aged-backstop-test`, { search: 'fresh.bin' });
    check('ZERO RESIDUE: aged intake row gone', !residueAged.data);
    check('ZERO RESIDUE: fresh intake row gone', !residueFresh.data);
    check('ZERO RESIDUE: user gone', !residueUser.data.user);
    check('ZERO RESIDUE: fresh storage object gone (cleaned up by this script, not the backstop)', !(residueFreshObject.data ?? []).some((f) => f.name === 'fresh.bin'));

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

main();
