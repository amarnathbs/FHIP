// FDH-3 — creates (idempotently) the private "fdh-source-documents" Storage
// bucket on whichever Supabase project .env.local points at, and prints its
// live configuration. Bucket creation is a Storage Admin API operation, not
// a SQL migration — see migration 0058's own header comment for why the
// bucket itself is created here rather than in SQL (identical precedent to
// 0022/report-exports and 0037/investment-source-documents).
//
// SAFETY: refuses to run against anything other than the FDH-3-certified DEV
// project ref, using the exact same guard as
// lib/financial-data-hub/constants/featureFlags.ts.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CERTIFIED_DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';
const BUCKET_ID = 'fdh-source-documents';

// Same manual .env.local loading convention as scripts/fdh1_closure_certification.mjs
// (no `dotenv` dependency in this repository).
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
  console.error(`Refusing to run: configured project (${url}) is not the certified FDH-3 DEV project (${CERTIFIED_DEV_PROJECT_REF}).`);
  process.exit(1);
}

const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: existing } = await admin.storage.getBucket(BUCKET_ID);
if (existing) {
  console.log(`Bucket already exists: ${JSON.stringify(existing)}`);
} else {
  const { data, error } = await admin.storage.createBucket(BUCKET_ID, {
    public: false,
    fileSizeLimit: 20 * 1024 * 1024, // matches FDH_MAX_FILE_SIZE_BYTES['application/pdf'], the larger of the two allowed types
    allowedMimeTypes: ['application/pdf', 'text/csv'],
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
console.log('\nOK: fdh-source-documents is private, size-limited and MIME-restricted.');
