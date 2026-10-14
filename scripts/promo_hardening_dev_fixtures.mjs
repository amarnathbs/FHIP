// Promo / Premium hardening: DEV FIXTURE users for the browser, HTTP and capability checks.
//
//   node scripts/promo_hardening_dev_fixtures.mjs create  --out <file outside the repository>
//   node scripts/promo_hardening_dev_fixtures.mjs cleanup --out <the same file>
//   node scripts/promo_hardening_dev_fixtures.mjs status
//
// SAFETY
//   * refuses unless NEXT_PUBLIC_SUPABASE_URL is the DEV project (vqycarelcoijzwlpkpcz); never production (twwpnltizhtjxhamyoxt);
//   * every user is synthetic, tagged `hardening-<run>-<label>@example.invalid`, with a RANDOM password generated here, written
//     ONLY to the --out file (outside the repository), and never printed;
//   * `create` records every id in the --out file; `cleanup` deletes exactly those users (their entitlement rows cascade) and their
//     admin_users rows, then re-queries and reports zero residue. Append-only audit rows (admin entitlement events, promo events,
//     monitoring events) remain by design and are counted, not hidden. A promo code cannot be deleted (trigger): the proofs
//     disable what they create.
//
// FIXTURE SET (each a separate account so a capability can be tested ALONE, Standard sections 2 and 3):
//   ent      admin_users row with can_manage_premium_entitlements only
//   promo    admin_users row with can_manage_promo_codes only
//   both     both ordinary capabilities, no override
//   ovr      both ordinary capabilities AND can_override_entitlement_limits (only when migration 0264 is applied)
//   ovronly  can_override_entitlement_limits alone (only when migration 0264 is applied)
//   super    an admin_users row with NO capability flag (stands for "an administrator who is not named for these duties")
//   user1..4 plain users (redeemers)
//   paid     a user with active paid Premium (plan_tier premium, source payment)
//   target   a plain user the grant proofs act on

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const DEV_REF = 'vqycarelcoijzwlpkpcz';
const PROD_REF = 'twwpnltizhtjxhamyoxt';

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const k = line.slice(0, i);
      if (env[k] === undefined) env[k] = line.slice(i + 1).trim();
    }
  } catch {
    /* optional */
  }
  return env;
}

const env = loadEnv();
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
if (URL_.includes(PROD_REF) || !URL_.includes(DEV_REF)) {
  console.error(`REFUSING: NEXT_PUBLIC_SUPABASE_URL must be the DEV project (${DEV_REF}); never production.`);
  process.exit(2);
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}
const svc = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const [, , command, ...rest] = process.argv;
const outIdx = rest.indexOf('--out');
const outFile = outIdx >= 0 ? rest[outIdx + 1] : null;

const LABELS = [
  { label: 'ent', caps: { can_manage_premium_entitlements: true } },
  { label: 'promo', caps: { can_manage_promo_codes: true } },
  { label: 'both', caps: { can_manage_premium_entitlements: true, can_manage_promo_codes: true } },
  { label: 'ovr', caps: { can_manage_premium_entitlements: true, can_manage_promo_codes: true, can_override_entitlement_limits: true } },
  { label: 'ovronly', caps: { can_override_entitlement_limits: true } },
  { label: 'super', caps: {} },
  { label: 'user1' },
  { label: 'user2' },
  { label: 'user3' },
  { label: 'user4' },
  { label: 'paid', paid: true },
  { label: 'target' },
];

async function hasColumn(table, column) {
  const r = await svc.from(table).select(column).limit(1);
  return !r.error;
}

async function create() {
  if (!outFile || /^[.]{0,2}[\\/]?(scripts|app|lib|docs|tests)[\\/]/.test(outFile)) {
    console.error('Give --out <a file OUTSIDE the repository> for the generated credentials.');
    process.exit(2);
  }
  const run = Date.now().toString(36);
  const overrideColumn = await hasColumn('admin_users', 'can_override_entitlement_limits');
  const made = [];
  for (const f of LABELS) {
    if (f.caps && 'can_override_entitlement_limits' in f.caps && !overrideColumn) {
      console.log(`skipped ${f.label}: the override capability column does not exist yet (migration 0264 not applied)`);
      continue;
    }
    const email = `hardening-${run}-${f.label}@example.invalid`;
    const password = `${crypto.randomBytes(18).toString('base64url')}aA1!`;
    const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`create ${f.label}: ${error?.message}`);
    const id = data.user.id;
    const profile = await svc.from('user_profiles').upsert(
      { user_id: id, country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), onboarding_completed: true, full_name: `Hardening ${f.label}` },
      { onConflict: 'user_id' }
    );
    if (profile.error) throw new Error(`profile ${f.label}: ${profile.error.message}`);
    if (f.caps) {
      const row = await svc.from('admin_users').insert({ user_id: id, notes: 'synthetic promo hardening fixture', ...f.caps });
      if (row.error) throw new Error(`admin_users ${f.label}: ${row.error.message}`);
    }
    if (f.paid) {
      const e = await svc.from('user_entitlements').upsert({ user_id: id, plan_tier: 'premium', entitlement_source: 'payment' }, { onConflict: 'user_id' });
      if (e.error) throw new Error(`entitlement ${f.label}: ${e.error.message}`);
    }
    made.push({ label: f.label, id, email, password });
  }
  fs.writeFileSync(outFile, JSON.stringify({ run, createdAt: new Date().toISOString(), project: DEV_REF, users: made }, null, 2));
  console.log(`created ${made.length} fixture users (run ${run}); credentials are in the --out file only: ${made.map((m) => m.label).join(', ')}`);
}

async function cleanup() {
  if (!outFile || !fs.existsSync(outFile)) {
    console.error('Give --out <the file written by create>.');
    process.exit(2);
  }
  const rec = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  let failed = 0;
  for (const u of rec.users) {
    await svc.from('admin_users').delete().eq('user_id', u.id);
    const { error } = await svc.auth.admin.deleteUser(u.id);
    if (error && !/not found/i.test(error.message)) {
      failed += 1;
      console.log(`FAIL delete ${u.label}: ${error.message}`);
    }
  }
  // independent re-query: nothing of this run may remain
  const ids = rec.users.map((u) => u.id);
  const still = await svc.from('user_entitlements').select('user_id').in('user_id', ids);
  const stillAdmin = await svc.from('admin_users').select('user_id').in('user_id', ids);
  const stillProfile = await svc.from('user_profiles').select('user_id').in('user_id', ids);
  const { data: authList } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const stillAuth = (authList?.users ?? []).filter((u) => ids.includes(u.id)).length;
  console.log(`residue after cleanup: user_entitlements=${still.data?.length ?? '?'} admin_users=${stillAdmin.data?.length ?? '?'} user_profiles=${stillProfile.data?.length ?? '?'} auth users=${stillAuth}`);
  const events = await svc.from('admin_entitlement_events').select('id', { count: 'exact', head: true }).in('target_user_id', ids);
  console.log(`append-only audit rows that remain by design: admin_entitlement_events for these users=${events.count ?? '?'}`);
  process.exit(failed || (still.data?.length ?? 0) || (stillAdmin.data?.length ?? 0) || stillAuth ? 1 : 0);
}

async function status() {
  const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const mine = (data?.users ?? []).filter((u) => /^hardening-[a-z0-9]+-/.test(u.email ?? ''));
  console.log(`fixture users currently on DEV: ${mine.length}`);
}

if (command === 'create') await create();
else if (command === 'cleanup') await cleanup();
else if (command === 'status') await status();
else {
  console.error('Usage: create --out <file> | cleanup --out <file> | status');
  process.exit(2);
}
