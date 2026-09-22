// NAV 1 R2 — dedicated synthetic DEV test-account setup for the UI-driven
// accepted-statement journey (browser-automated, not a service-level call).
// Mirrors the exact synthetic-fixture pattern nav1_real_accepted_statement_journey.ts
// (Priority 4, prior continuation) already used and this ledger already
// recorded as PO-pre-authorized -- only difference: this account also gets
// onboarding_completed=true and a confirmed country/profile so it lands
// straight on /dashboard after a real browser sign-in, instead of the
// onboarding wizard (a separate, unrelated flow this dispatch is not
// testing).
//
// Usage: npx tsx --env-file=.env.local scripts/nav1_r2_ui_journey_setup.ts
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(process.cwd());
const envFile = path.join(repoRoot, '.env.local');
const env: Record<string, string> = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
const actualRef = new URL(BASE).host.split('.')[0];
if (actualRef !== EXPECTED_DEV_REF) {
  console.error(`REFUSING TO RUN: target project "${actualRef}" is not the expected DEV project.`);
  process.exit(1);
}

const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN_TAG = `nav1-r2-${Date.now()}`;
const EMAIL = `${RUN_TAG}@fhip-synthetic.test`;
const PASSWORD = `Synthetic!${randomUUID()}`;

async function main() {
  const { data, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create synthetic user: ${error?.message}`);
  const userId = data.user.id;

  const { error: profErr } = await admin
    .from('user_profiles')
    .update({
      onboarding_completed: true,
      country_of_residence: 'IN',
      country_confirmed_at: new Date().toISOString(),
      country_source: 'USER_CONFIRMED',
      preferred_currency: 'INR',
      full_name: `NAV1 R2 UI Journey ${RUN_TAG}`,
    })
    .eq('user_id', userId);
  if (profErr) throw new Error(`user_profiles update failed: ${profErr.message}`);

  const { data: hh, error: hhErr } = await admin
    .from('households')
    .insert({ user_id: userId, household_name: `NAV1 R2 UI Journey`, primary_country: 'IN' })
    .select('id')
    .single();
  if (hhErr || !hh) throw new Error(`household insert failed: ${hhErr?.message}`);
  const { error: memErr } = await admin
    .from('household_members')
    .insert({ user_id: userId, household_id: hh.id, full_name: `NAV1 R2 UI Journey Self`, relationship: 'self' });
  if (memErr) throw new Error(`household_member insert failed: ${memErr.message}`);

  const fixture = { runTag: RUN_TAG, userId, email: EMAIL, password: PASSWORD, householdId: hh.id };
  const outPath = process.env.NAV1_R2_FIXTURE_OUT || path.join(repoRoot, '.nav1_r2_fixture.json');
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log('SYNTHETIC TEST ACCOUNT CREATED (DEV only, clearly-labelled, real Supabase Admin Auth API):');
  console.log(JSON.stringify({ runTag: RUN_TAG, userId, email: EMAIL, householdId: hh.id }, null, 2));
  console.log(`(password written only to ${outPath}, not printed here)`);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
