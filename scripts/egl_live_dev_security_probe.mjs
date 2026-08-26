// Education/Children Investment -> Goal Linkage — live DEV security probe.
// Reproduces the REAL, currently-live goal_funding_sources ownership gap
// (spec s.60, s.86) against the actual DEV Supabase project using two
// throwaway authenticated users and direct PostgREST calls — no app code
// involved, isolating the database/RLS layer exactly like migration 0093's
// gfs_enforce_ownership trigger + WITH CHECK rewrite target.
//
// This is intentionally run BEFORE migration 0093 is applied to DEV (this
// sandbox has no DDL-execution capability — see scripts/fdh1_live_dev_
// verification.mjs's header note, same limitation) — it exists to prove
// the gap is real on live infrastructure, not just a PGlite theoretical
// concern. The PGlite certification (scripts/db-rebuild-check/
// education_goal_linkage.mjs) already proves, on a real Postgres engine
// with the fix applied, that the identical forged request is rejected.
//
// Test users are cleaned up (soft, via Auth Admin delete) at the end
// regardless of outcome.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const envText = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); } else { fail++; console.log(`  FAIL  ${label} ${detail}`); } };

async function restFetch(p, { method = 'GET', apikey, token, body, prefer } = {}) {
  const headers = { apikey, Authorization: `Bearer ${token ?? apikey}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (prefer) headers['Prefer'] = prefer;
  const r = await fetch(`${URL}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

async function main() {
  console.log('=== Education/Children Investment -> Goal Linkage: live DEV security probe ===');
  console.log('Project:', URL, '\n');

  const stamp = Date.now();
  const emailA = `egl-test-a-${stamp}@fhip-test.local`;
  const emailB = `egl-test-b-${stamp}@fhip-test.local`;
  const password = 'TestPass!' + stamp;

  async function createUser(email) {
    return restFetch('/auth/v1/admin/users', { method: 'POST', apikey: SERVICE, token: SERVICE, body: { email, password, email_confirm: true } });
  }
  async function signIn(email) {
    const r = await restFetch('/auth/v1/token?grant_type=password', { method: 'POST', apikey: ANON, body: { email, password } });
    return { token: r.json.access_token, userId: r.json.user?.id };
  }

  const createdA = await createUser(emailA);
  const createdB = await createUser(emailB);
  if (createdA.status >= 300 || createdB.status >= 300) {
    console.error('Could not create test users:', JSON.stringify({ createdA: createdA.json, createdB: createdB.json }));
    process.exit(9);
  }
  const userAId = createdA.json.id;
  const userBId = createdB.json.id;
  const A = await signIn(emailA);
  const B = await signIn(emailB);
  console.log(`Test users created: A=${userAId}, B=${userBId}\n`);

  try {
    // Each user creates their own goal + investment via their own JWT (real
    // RLS-governed inserts — proves legitimate same-tenant writes work).
    const goalA = await restFetch('/rest/v1/user_goals', {
      method: 'POST', apikey: ANON, token: A.token, prefer: 'return=representation',
      body: { user_id: userAId, goal_name: 'A Education Goal', goal_type: 'Education', goal_category: 'education', status: 'active', target_amount: 50000, current_amount: 0, currency_code: 'AUD', target_amount_basis: 'today_value' },
    });
    check('Tenant A can create own goal', goalA.status === 201, `(status ${goalA.status})`);
    const goalAId = goalA.json?.[0]?.id;

    const invB = await restFetch('/rest/v1/investments', {
      method: 'POST', apikey: ANON, token: B.token, prefer: 'return=representation',
      body: { user_id: userBId, investment_name: 'B ETF (private)', investment_type: 'etf', current_value: 77000, currency_code: 'AUD', owner: 'self' },
    });
    check('Tenant B can create own investment', invB.status === 201, `(status ${invB.status})`);
    const invBId = invB.json?.[0]?.id;

    if (!goalAId || !invBId) {
      console.error('Setup rows missing — aborting probe.');
      process.exit(9);
    }

    // --- THE PROBE: Tenant A links their own goal to Tenant B's investment,
    // using ONLY Tenant A's JWT (user_id correctly set to A — RLS's
    // auth.uid()=user_id check alone would pass this). ---
    console.log('\n--- Probe: Tenant A links OWN goal to Tenant B\'s PRIVATE investment (forged linked_investment_id) ---');
    const forgeAttempt = await restFetch('/rest/v1/goal_funding_sources', {
      method: 'POST', apikey: ANON, token: A.token, prefer: 'return=representation',
      body: { goal_id: goalAId, user_id: userAId, source_type: 'investment', linked_investment_id: invBId, allocated_amount: 77000, allocation_percentage: 100, is_active: true },
    });
    console.log(`  Result: HTTP ${forgeAttempt.status}`, JSON.stringify(forgeAttempt.json).slice(0, 300));

    const preMigrationVulnerable = forgeAttempt.status === 201;
    if (preMigrationVulnerable) {
      console.log('\n  *** CONFIRMED LIVE: current DEV schema (pre-0093) allows this forged cross-tenant reference. ***');
      console.log('  *** Migration 0093 (gfs_enforce_ownership trigger + WITH CHECK rewrite) is the fix — already ***');
      console.log('  *** proven to reject the byte-identical scenario under PGlite (education_goal_linkage.mjs).  ***');
      check('Live DEV reproduction: forged cross-tenant link currently SUCCEEDS (confirms the real gap migration 0093 fixes)', true);
      // Clean up the forged row itself via service role (do not leave attack evidence behind in DEV).
      if (forgeAttempt.json?.[0]?.id) {
        await restFetch(`/rest/v1/goal_funding_sources?id=eq.${forgeAttempt.json[0].id}`, { method: 'DELETE', apikey: SERVICE, token: SERVICE });
      }
    } else {
      // If DEV has ALREADY had 0093 (or an equivalent fix) applied by the time this runs, the forged
      // insert should be rejected — treat that as the GOOD outcome and verify it's a real ownership
      // rejection, not an unrelated error.
      const rejectedForRightReason = forgeAttempt.status === 401 || forgeAttempt.status === 403 || /owned by user|42501|row-level|policy/i.test(JSON.stringify(forgeAttempt.json));
      check('Live DEV: forged cross-tenant link is REJECTED (0093 already applied) — verify rejection is ownership-based', rejectedForRightReason, `(status ${forgeAttempt.status})`);
    }

    // Negative control proving this test is not vacuous: Tenant A CAN legitimately
    // link their OWN goal to their OWN investment.
    const invA = await restFetch('/rest/v1/investments', {
      method: 'POST', apikey: ANON, token: A.token, prefer: 'return=representation',
      body: { user_id: userAId, investment_name: 'A ETF (own)', investment_type: 'etf', current_value: 40000, currency_code: 'AUD', owner: 'self' },
    });
    const invAId = invA.json?.[0]?.id;
    const legitAttempt = await restFetch('/rest/v1/goal_funding_sources', {
      method: 'POST', apikey: ANON, token: A.token, prefer: 'return=representation',
      body: { goal_id: goalAId, user_id: userAId, source_type: 'investment', linked_investment_id: invAId, allocated_amount: 40000, allocation_percentage: 100, is_active: true },
    });
    check('Negative control: Tenant A linking OWN goal to OWN investment succeeds (test is not vacuous / not just broken auth)', legitAttempt.status === 201, `(status ${legitAttempt.status})`);

    console.log(`\nLIVE DEV SECURITY PROBE: ${pass} passed, ${fail} failed`);
  } finally {
    // Cleanup: delete test users (cascades their rows via auth.users FK on delete cascade).
    await restFetch(`/auth/v1/admin/users/${userAId}`, { method: 'DELETE', apikey: SERVICE, token: SERVICE });
    await restFetch(`/auth/v1/admin/users/${userBId}`, { method: 'DELETE', apikey: SERVICE, token: SERVICE });
    console.log('\nTest users cleaned up.');
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('UNCAUGHT:', e); process.exit(9); });
