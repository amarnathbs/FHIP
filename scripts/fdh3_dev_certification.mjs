// FDH-3 — LIVE DEV storage certification (spec sections 102-103): "PGlite
// alone is not enough for storage certification... verify the object
// actually disappears after purge; do not infer storage deletion from DB
// status." This script performs REAL Supabase Storage operations against
// the fdh-source-documents bucket (project vqycarelcoijzwlpkpcz) using
// synthetic bytes only.
//
// SCOPE NOTE. This certifies the STORAGE INFRASTRUCTURE facts (private
// bucket, real upload/signed-read/delete/verify-absent, no public/anon
// access) using the service-role client, because migration 0058's tables and
// its `storage.objects` RLS policy have NOT yet been applied to DEV — see
// docs/financial-data-hub/FDH3_COMPLETION_REPORT.md "DEV" line. The
// ACCESS-CONTROL LOGIC itself (tenant isolation, the FDH1-F1 triggers, the
// storage.objects SELECT policy) is certified against a full clean rebuild
// in scripts/fdh3_rls_certification.mjs (PGlite), 18/18 passing with real
// negative controls. Both are required; neither alone is sufficient.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const CERTIFIED_DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';
const BUCKET_ID = 'fdh-source-documents';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_.includes(CERTIFIED_DEV_PROJECT_REF)) { console.error('Refusing: not the certified DEV project'); process.exit(1); }

const admin = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const anon = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

var pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };

const SYNTHETIC_USER = '99999999-9999-9999-9999-999999999999'; // opaque, fictitious — no real account
const SYNTHETIC_DOC = crypto.randomUUID();
const KEY = `${SYNTHETIC_USER}/${SYNTHETIC_DOC}/${SYNTHETIC_DOC}.bin`;
const SYNTHETIC_PDF = new TextEncoder().encode('%PDF-1.4\n%% synthetic FDH-3 certification fixture — not a real document\n%%EOF');

console.log(`=== FDH-3 LIVE DEV STORAGE CERTIFICATION (${BUCKET_ID}) ===\n`);

// 1. Bucket is private.
const { data: bucket } = await admin.storage.getBucket(BUCKET_ID);
check('bucket exists and is NOT public', Boolean(bucket) && bucket.public === false, `(public=${bucket?.public})`);

// 2. Service-role upload (the only write path FDH-3 ever uses — see storage.ts).
const { error: uploadError } = await admin.storage.from(BUCKET_ID).upload(KEY, SYNTHETIC_PDF, {
  contentType: 'application/pdf', upsert: false,
});
check('service-role upload succeeds', !uploadError, uploadError ? `(${uploadError.message})` : '');

// 3. Object is listable/verifiable via service role (mirrors verifyDocumentObjectExists).
const dir = KEY.slice(0, KEY.lastIndexOf('/'));
const name = KEY.slice(KEY.lastIndexOf('/') + 1);
const { data: listed } = await admin.storage.from(BUCKET_ID).list(dir, { search: name });
check('uploaded object is verifiable by listing (never inferred)', (listed ?? []).some((f) => f.name === name));

// 4. NO PUBLIC ACCESS: the bucket's public URL must NOT serve the object.
const publicUrl = `${URL_}/storage/v1/object/public/${BUCKET_ID}/${KEY}`;
const publicRes = await fetch(publicUrl);
check('public URL does NOT serve the object (bucket is genuinely private)', publicRes.status !== 200, `(HTTP ${publicRes.status})`);

// 5. Anonymous key cannot read the object directly either (no anon SELECT policy exists in DEV pre-migration, and even once migration 0058 applies, anon has no policy — only authenticated does).
const { error: anonDownloadError } = await anon.storage.from(BUCKET_ID).download(KEY);
check('anon key cannot download the object', Boolean(anonDownloadError));

// 6. Signed URL: short-lived, works while it is valid.
const { data: signed, error: signError } = await admin.storage.from(BUCKET_ID).createSignedUrl(KEY, 60);
check('service-role can create a signed URL', !signError && Boolean(signed?.signedUrl), signError ? `(${signError.message})` : '');
if (signed?.signedUrl) {
  const signedRes = await fetch(signed.signedUrl);
  check('the signed URL actually resolves the real bytes while valid', signedRes.status === 200, `(HTTP ${signedRes.status})`);
  const body = new Uint8Array(await signedRes.arrayBuffer());
  check('downloaded bytes match the uploaded synthetic PDF exactly', Buffer.from(body).equals(Buffer.from(SYNTHETIC_PDF)));
}

// 7. PURGE: delete, then INDEPENDENTLY VERIFY absence — never inferred.
const { error: deleteError } = await admin.storage.from(BUCKET_ID).remove([KEY]);
check('delete succeeds', !deleteError, deleteError ? `(${deleteError.message})` : '');
const { data: listedAfter } = await admin.storage.from(BUCKET_ID).list(dir, { search: name });
check('object is verifiably ABSENT after delete (purge verification, not inference)', !(listedAfter ?? []).some((f) => f.name === name));

// 8. A signed URL issued before the purge no longer resolves real content afterward.
if (signed?.signedUrl) {
  const afterPurgeRes = await fetch(signed.signedUrl);
  check('a pre-purge signed URL no longer serves the object after purge', afterPurgeRes.status !== 200, `(HTTP ${afterPurgeRes.status})`);
}

console.log(`\n=== FDH-3 LIVE DEV STORAGE CERTIFICATION: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
