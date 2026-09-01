// Admin A0.2 Wave 3 — Gate 1 live-DEV verification: FIXTURE SETUP.
//
// Creates synthetic, disposable fixtures only (prefix `a02w3-`) so the two
// newly-connected Benchmarks actions (Sources Approve/Suspend/Reinstate,
// Datasets Validate) can be exercised through the REAL running app over a
// REAL HTTP round trip (browser login -> real session cookies -> real route
// handlers -> real DEV Postgres), not just code inspection or a direct
// RPC/PostgREST call.
//
// Same safety posture as scripts/admin_a02_wave2_live_dev_verification.mjs:
//   * refuses to run against anything but the certified DEV project ref;
//   * every fixture is prefixed and its id recorded for cleanup;
//   * never touches the 84 curated Resources or any pre-existing Benchmarks
//     row;
//   * a companion cleanup script (admin_a02_wave3_gate1_cleanup.mjs) removes
//     every fixture and re-counts affected tables before/after.
//
// Usage: node scripts/admin_a02_wave3_gate1_setup.mjs > wave3-gate1-setup.json
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
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

if (!/vqycarelcoijzwlpkpcz/.test(url)) {
  console.error(`REFUSING TO RUN: target ${url} is not the certified DEV project. This script must never run against production.`);
  process.exit(2);
}

const RUN = `a02w3-${Date.now().toString(36)}`;
const PASSWORD = 'Wave3-Gate1-Synthetic-2026!';

async function makeUser(label, { asAdmin }) {
  const email = `${RUN}-${label}@test.fhip.invalid`;
  const { data: created, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !created.user) throw new Error(`create user ${label}: ${error?.message}`);
  const userId = created.user.id;

  // Country gate (MCC): requireAdmin() calls countryConfirmationBlockResponse
  // before the admin_users check even runs on some paths -- both synthetic
  // users need a confirmed country or the live test would measure the
  // country gate, not the Benchmarks authorization boundary it's meant to.
  // onboarding_completed is separately required by the app's general
  // onboarding wizard gate (app/(app)/layout.tsx) -- found live, the hard
  // way, when the first attempt at this Gate 1 verification landed on the
  // onboarding wizard instead of /admin/benchmarks.
  const { error: pErr } = await admin.from('user_profiles').upsert(
    {
      user_id: userId,
      country_of_residence: 'AU',
      country_confirmed_at: new Date().toISOString(),
      onboarding_completed: true,
      full_name: 'Wave 3 Gate 1 Synthetic',
    },
    { onConflict: 'user_id' }
  );
  if (pErr) throw new Error(`profile ${label}: ${pErr.message}`);

  if (asAdmin) {
    const { error: aErr } = await admin.from('admin_users').insert({ user_id: userId });
    if (aErr) throw new Error(`admin_users ${label}: ${aErr.message}`);
  }
  return { email, userId };
}

async function main() {
  const superAdmin = await makeUser('super-admin', { asAdmin: true });
  const nonAdmin = await makeUser('non-admin', { asAdmin: false });

  // A source starting in 'draft' so Approve has something real to do.
  const { data: source, error: sErr } = await admin
    .from('benchmark_sources')
    .insert({
      source_name: `${RUN}-source`,
      source_type: 'internal',
      publisher: 'Wave 3 Gate 1 fixture',
      source_title: `${RUN} synthetic source`,
      country_code: 'AU',
      citation_text: `${RUN} synthetic citation`,
      status: 'draft',
      created_by: superAdmin.userId,
    })
    .select('id')
    .single();
  if (sErr) throw new Error(`source: ${sErr.message}`);

  // A dataset citing that source, deliberately INCOMPLETE (no
  // geography_level/statistic_coverage/source_period, source not yet
  // approved) so the first live Validate call has real, visible reasons to
  // show, proving the preview reflects genuine data, not a hardcoded string.
  const { data: dataset, error: dErr } = await admin
    .from('benchmark_datasets')
    .insert({
      benchmark_source_id: source.id,
      dataset_name: `${RUN}-dataset`,
      version: '1',
      benchmark_class: 'fhip_planning', // no cohort/value requirement, so the ONLY failures are the ones this fixture is designed to show
      data_status: 'draft',
    })
    .select('id')
    .single();
  if (dErr) throw new Error(`dataset: ${dErr.message}`);

  console.log(
    JSON.stringify(
      {
        run: RUN,
        password: PASSWORD,
        superAdmin,
        nonAdmin,
        sourceId: source.id,
        datasetId: dataset.id,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('SETUP FAILED:', err.message);
  process.exit(1);
});
