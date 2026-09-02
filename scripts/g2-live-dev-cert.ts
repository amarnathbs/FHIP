// G2 live-DEV closure (gap G2-R4) — synthetic-user setup/verify/teardown
// helper. Follows the exact hard-DEV-guard pattern already established by
// tests/live-dev/module11ResidualLiveDev.test.ts: refuses to run against
// anything but the one confirmed DEV project ref, never reads/uses
// PRODUCTION_SUPABASE_SERVICE_ROLE_KEY (present in this worktree's
// .env.local by accident of a sibling-worktree file copy per the
// coordinator's own message — this script only ever reads
// SUPABASE_SERVICE_ROLE_KEY, the DEV key).
//
// Usage (run with `npx tsx --env-file=.env.local scripts/g2-live-dev-cert.ts <command>`):
//   setup     - creates 3 synthetic auth users + user_profiles rows, writes
//               credentials to a local scratchpad JSON file (never printed)
//   check-billing <userId> - prints billing_country/billing_country_confirmed_at
//               for one profile (read-only, proves billing-authority separation)
//   teardown  - deletes every synthetic user created this run, then
//               independently RE-QUERIES both auth.users and user_profiles
//               to prove deletion (never trusts the delete response alone)
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY; // NEVER PRODUCTION_SUPABASE_SERVICE_ROLE_KEY

if (!BASE || !ANON || !SERVICE) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
}
const actualRef = new URL(BASE).host.split('.')[0];
if (actualRef !== EXPECTED_DEV_REF) {
  throw new Error(`REFUSING TO RUN: target project "${actualRef}" is not the expected DEV project (${EXPECTED_DEV_REF}). This script never touches production.`);
}

const admin = createClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const STATE_FILE = path.resolve(
  'C:/Users/user/AppData/Local/Temp/claude/D--FHIP/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad/g2-live-dev-users.json'
);

interface SyntheticUserRecord {
  label: string;
  userId: string;
  email: string;
  password: string;
}

function loadState(): SyntheticUserRecord[] {
  if (!fs.existsSync(STATE_FILE)) return [];
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
function saveState(records: SyntheticUserRecord[]) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(records, null, 2));
}

const RUN_TAG = `g2live${Date.now()}`;

async function createSyntheticUser(
  label: string,
  profile: {
    onboarding_completed: boolean;
    country_of_residence: string | null;
    country_confirmed_at: string | null;
    country_source: string | null;
    primary_country?: string | null;
    primary_country_source?: string | null;
    preferred_currency?: string | null;
  }
): Promise<SyntheticUserRecord> {
  const email = `${RUN_TAG}-${label}@fhip-synthetic.test`;
  const password = `Syn!${RUN_TAG}${label}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create synthetic user ${label}: ${error?.message}`);
  const userId = data.user.id;

  const { error: upsertError } = await admin
    .from('user_profiles')
    .upsert({ user_id: userId, ...profile }, { onConflict: 'user_id' });
  if (upsertError) throw new Error(`could not configure profile for ${label}: ${upsertError.message}`);

  return { label, userId, email, password };
}

async function setup() {
  const records: SyntheticUserRecord[] = [];

  records.push(
    await createSyntheticUser('au-confirmed', {
      onboarding_completed: true,
      country_of_residence: 'AU',
      country_confirmed_at: new Date().toISOString(),
      country_source: 'USER_CONFIRMED',
      primary_country: 'AU',
      primary_country_source: 'USER_CONFIRMED',
      preferred_currency: 'AUD',
    })
  );

  records.push(
    await createSyntheticUser('unconfirmed', {
      onboarding_completed: true,
      country_of_residence: null,
      country_confirmed_at: null,
      country_source: null,
      primary_country: null,
      preferred_currency: null,
    })
  );

  saveState(records);
  console.log(
    JSON.stringify(
      records.map((r) => ({ label: r.label, userId: r.userId, email: r.email })),
      null,
      2
    )
  );
  console.log(`Full credentials (incl. password) written to: ${STATE_FILE}`);
}

async function checkBilling(userId: string) {
  const { data, error } = await admin
    .from('user_profiles')
    .select('user_id, billing_country, billing_country_confirmed_at, country_of_residence, primary_country')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  console.log(JSON.stringify(data, null, 2));
}

async function teardown() {
  const records = loadState();
  if (records.length === 0) {
    console.log('No synthetic users recorded in state file — nothing to tear down.');
    return;
  }

  const results: Array<{ label: string; userId: string; deleteOk: boolean; authRowGoneConfirmed: boolean; profileRowGoneConfirmed: boolean }> = [];

  for (const r of records) {
    const { error: delErr } = await admin.auth.admin.deleteUser(r.userId);
    const deleteOk = !delErr;

    // Independently re-query BOTH auth.users (via admin.auth.admin.getUserById)
    // and user_profiles directly -- never trust the delete call's own
    // response as proof of deletion.
    const { data: reFetched } = await admin.auth.admin.getUserById(r.userId);
    const authRowGoneConfirmed = !reFetched?.user;

    const { data: profileRow } = await admin.from('user_profiles').select('user_id').eq('user_id', r.userId).maybeSingle();
    const profileRowGoneConfirmed = !profileRow;

    results.push({ label: r.label, userId: r.userId, deleteOk, authRowGoneConfirmed, profileRowGoneConfirmed });
  }

  console.log(JSON.stringify(results, null, 2));

  const allClean = results.every((r) => r.deleteOk && r.authRowGoneConfirmed && r.profileRowGoneConfirmed);
  if (allClean) {
    fs.rmSync(STATE_FILE, { force: true });
    console.log('ALL SYNTHETIC USERS CONFIRMED DELETED (auth.users + user_profiles re-queried independently). State file removed.');
  } else {
    console.log('WARNING: not all synthetic users were confirmed deleted. State file retained for retry.');
    process.exitCode = 1;
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'setup') return setup();
  if (cmd === 'check-billing') return checkBilling(process.argv[3]);
  if (cmd === 'teardown') return teardown();
  throw new Error(`unknown command: ${cmd}. Use setup | check-billing <userId> | teardown`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
