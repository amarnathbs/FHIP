// One-off addendum to admin_a02_wave3_gate1_setup.mjs: the app's general
// onboarding gate (user_profiles.onboarding_completed) intercepts a
// brand-new synthetic user before the Admin surface is ever reached, even
// with country_confirmed_at already set. Marks both Gate 1 fixture users as
// onboarding-complete so the live HTTP round trip actually reaches
// /admin/benchmarks rather than the onboarding wizard.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
if (!/vqycarelcoijzwlpkpcz/.test(env.NEXT_PUBLIC_SUPABASE_URL)) {
  console.error('REFUSING TO RUN: not the certified DEV project.');
  process.exit(2);
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const userIds = process.argv.slice(2);
if (userIds.length === 0) {
  console.error('Usage: node scripts/admin_a02_wave3_gate1_fix_onboarding.mjs <userId> [<userId> ...]');
  process.exit(1);
}
for (const id of userIds) {
  const { error } = await admin.from('user_profiles').update({ onboarding_completed: true, full_name: 'Wave 3 Gate 1 Synthetic' }).eq('user_id', id);
  if (error) {
    console.error(id, 'FAILED', error.message);
    process.exitCode = 1;
  } else {
    console.log(id, 'OK');
  }
}
