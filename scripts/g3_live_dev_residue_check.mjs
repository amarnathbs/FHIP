// G3 §18 residue reconciliation — read-only unless --clean is passed.
//
// Run AFTER all live-DEV and browser certification, to prove that every
// synthetic identity this phase created is gone, and to report honestly on
// anything that legitimately remains.
//
//   node --env-file=.env.local scripts/g3_live_dev_residue_check.mjs
//   node --env-file=.env.local scripts/g3_live_dev_residue_check.mjs --clean
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) { console.error('missing DEV credentials'); process.exit(2); }
if (/prod/i.test(url)) { console.error('REFUSING: looks like production'); process.exit(3); }

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const CLEAN = process.argv.includes('--clean');

// Every synthetic-identity pattern this phase is responsible for.
const MINE = [/^g3cert\./i, /^g3e2e\./i];

const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) { console.error(error.message); process.exit(1); }
const all = data?.users ?? [];

const mine = all.filter((u) => MINE.some((re) => re.test(u.email ?? '')));
console.log(`total auth identities on DEV: ${all.length}`);
console.log(`identities created by G3 certification: ${mine.length}`);

if (mine.length && CLEAN) {
  for (const u of mine) {
    await admin.from('cross_border_relationships').delete().eq('user_id', u.id);
    const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
    console.log(`  ${delErr ? 'FAILED ' : 'deleted'} ${u.id}`);
  }
  const { data: after } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const left = (after?.users ?? []).filter((u) => MINE.some((re) => re.test(u.email ?? '')));
  console.log(`remaining after cleanup: ${left.length}`);
  process.exit(left.length === 0 ? 0 : 1);
}

// Pre-existing spec fixtures that are NOT this phase's to clean up, reported
// so the distinction is explicit rather than silently lumped in.
const otherSpecFixtures = all.filter((u) => /^(nav-test|test)\+/i.test(u.email ?? ''));
console.log(`identities left by OTHER (pre-existing) e2e specs: ${otherSpecFixtures.length} — not G3's to remove`);

// Immutable audit residue: audit_events.user_id is ON DELETE SET NULL, so a
// confirmation event legitimately survives its account's deletion.
const { data: orphans } = await admin
  .from('audit_events')
  .select('id, user_id, metadata')
  .eq('event_type', 'country_confirmed')
  .is('user_id', null);
const fromRpc = (orphans ?? []).filter((r) => r.metadata?.written_by === 'confirm_country_of_residence');
console.log(`immutable audit residue: ${fromRpc.length} orphaned country_confirmed events (user_id NULLed by the FK)`);
console.log('  These carry no user identifier and are deliberately retained — they are the audit trail G3-R5 requires to be unskippable.');

process.exit(mine.length === 0 ? 0 : 1);
