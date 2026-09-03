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
//
// The last three are NOT G3's own fixtures — they belong to the two
// pre-existing e2e specs. They are included because THIS SESSION ran those
// specs (to repair and re-verify them), and anything this session created is
// this session's to clean up. Only rows created on the session date are ever
// removed; older ones from previous sessions are reported and left alone.
const MINE = [/^g3cert\./i, /^g3e2e\./i];
const SESSION_SPEC_FIXTURES = [/^nav-test\+/i, /^nav-admin\+/i, /^test\+/i];
const SESSION_DATE = process.env.G3_SESSION_DATE ?? new Date().toISOString().slice(0, 10);

const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) { console.error(error.message); process.exit(1); }
const all = data?.users ?? [];

const mine = all.filter((u) => MINE.some((re) => re.test(u.email ?? '')));
console.log(`total auth identities on DEV: ${all.length}`);
console.log(`identities created by G3 certification: ${mine.length}`);

const specFixtures = all.filter((u) => SESSION_SPEC_FIXTURES.some((re) => re.test(u.email ?? '')));
const specToday = specFixtures.filter((u) => (u.created_at ?? '').slice(0, 10) === SESSION_DATE);
const specOlder = specFixtures.filter((u) => (u.created_at ?? '').slice(0, 10) !== SESSION_DATE);
console.log(`e2e-spec fixtures created by THIS session (${SESSION_DATE}): ${specToday.length}`);
console.log(`e2e-spec fixtures from earlier sessions: ${specOlder.length} — reported, never touched`);

// AUDIT RESIDUE.
//
// `written_by: confirm_country_of_residence` only exists in the RPC that
// migration 0127 introduced, which reached DEV on the session date — so every
// row carrying that marker was written by this session's certification runs.
// Rows WITHOUT the marker predate 0127 and are not this session's to touch.
//
// These are removed rather than retained. `audit_events.user_id` is ON DELETE
// SET NULL, but `entity_id` is a plain uuid with no FK, so a deleted
// account's id survives there — and the marker names the writing FUNCTION,
// not the purpose, so a synthetic confirmation is indistinguishable from a
// genuine one. Leaving them would pollute a real audit trail with fake
// confirmations, which is worse for audit integrity than removing them.
const { data: auditRows } = await admin
  .from('audit_events')
  .select('id, user_id, entity_id, metadata, created_at')
  .eq('event_type', 'country_confirmed');
const rpcWritten = (auditRows ?? []).filter((r) => r.metadata?.written_by === 'confirm_country_of_residence');
const legacy = (auditRows ?? []).filter((r) => !r.metadata?.written_by);
console.log(`country_confirmed audit rows written by this session's RPC: ${rpcWritten.length}`);
console.log(`  of those, orphaned (owner already deleted): ${rpcWritten.filter((r) => !r.user_id).length}`);
console.log(`legacy pre-0127 audit rows (no written_by marker): ${legacy.length} — not this session's, left alone`);

if (CLEAN) {
  for (const u of [...mine, ...specToday]) {
    await admin.from('cross_border_relationships').delete().eq('user_id', u.id);
    await admin.from('audit_events').delete().eq('entity_id', u.id);
    const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
    if (delErr) console.log(`  FAILED to delete ${u.id}: ${delErr.message}`);
  }
  if (rpcWritten.length) {
    await admin.from('audit_events').delete().in('id', rpcWritten.map((r) => r.id));
  }

  // Re-query everything, as §18 requires.
  const { data: after } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const leftMine = (after?.users ?? []).filter((u) => MINE.some((re) => re.test(u.email ?? '')));
  const leftSpec = (after?.users ?? []).filter(
    (u) => SESSION_SPEC_FIXTURES.some((re) => re.test(u.email ?? '')) && (u.created_at ?? '').slice(0, 10) === SESSION_DATE
  );
  const { data: afterAudit } = await admin.from('audit_events').select('id, metadata').eq('event_type', 'country_confirmed');
  const leftRpc = (afterAudit ?? []).filter((r) => r.metadata?.written_by === 'confirm_country_of_residence');
  console.log(`\nAFTER CLEANUP  G3 identities: ${leftMine.length}  session spec fixtures: ${leftSpec.length}  session audit rows: ${leftRpc.length}`);
  console.log(`               untouched legacy audit rows: ${(afterAudit ?? []).filter((r) => !r.metadata?.written_by).length}`);
  process.exit(leftMine.length === 0 && leftSpec.length === 0 && leftRpc.length === 0 ? 0 : 1);
}

process.exit(mine.length === 0 && specToday.length === 0 && rpcWritten.length === 0 ? 0 : 1);
