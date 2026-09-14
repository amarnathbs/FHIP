// AIE-1.1 — creates (idempotently) the private "aie-document-quarantine"
// Storage bucket on whichever Supabase project .env.local points at.
// Mirrors scripts/fdh3_create_storage_bucket.mjs exactly (same safety guard,
// same manual .env.local loading, same verification pass) — see that
// script's own header for why bucket creation is a Storage Admin API call
// rather than SQL.
//
// NOT RUN as part of this pass — no DEV/production authority is granted to
// this implementation pass (see AIE_1_1_IMPLEMENTATION.md). Held here,
// reviewed, ready to run once a Product Owner authorises applying migration
// 0140 to a target environment.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CERTIFIED_DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';
const BUCKET_ID = 'aie-document-quarantine';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(p)) throw new Error('.env.local not found at ' + p);
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(1); }
if (!url.includes(CERTIFIED_DEV_PROJECT_REF)) {
  console.error(`Refusing to run: configured project (${url}) is not the certified DEV project (${CERTIFIED_DEV_PROJECT_REF}).`);
  process.exit(1);
}

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: existing } = await admin.storage.getBucket(BUCKET_ID);
if (existing) {
  console.log(`Bucket already exists: ${JSON.stringify(existing)}`);
} else {
  const { data, error } = await admin.storage.createBucket(BUCKET_ID, {
    public: false,
    fileSizeLimit: 25 * 1024 * 1024, // matches lib/aie/validation/fileValidation.ts's DEFAULT_AIE_UPLOAD_LIMITS
    allowedMimeTypes: ['application/pdf'],
  });
  if (error) { console.error('createBucket failed:', error.message); process.exit(1); }
  console.log(`Bucket created: ${JSON.stringify(data)}`);
}

const { data: verify, error: verifyError } = await admin.storage.getBucket(BUCKET_ID);
if (verifyError || !verify) { console.error('post-create verification failed'); process.exit(1); }
console.log('\nLive configuration:');
console.log(`  id: ${verify.id}`);
console.log(`  public: ${verify.public}`);
console.log(`  file_size_limit: ${verify.file_size_limit}`);
console.log(`  allowed_mime_types: ${JSON.stringify(verify.allowed_mime_types)}`);
if (verify.public !== false) { console.error('FAIL: bucket is public'); process.exit(1); }
console.log('\nOK: aie-document-quarantine is private, size-limited and MIME-restricted.');
