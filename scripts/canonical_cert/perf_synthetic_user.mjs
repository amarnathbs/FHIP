/**
 * SPD-14 / mission section 9 (dashboard performance) -- a single, disposable synthetic user for the
 * before/after live-DEV timing measurement, ISOLATED from the shared FCAST/E2E50 fixture pool
 * (`USER_RANGES.json`): this is a one-off measurement, not a certifier occupying a range, so it must
 * never touch or collide with another concurrent session's range/port/fixture data.
 *
 *   node scripts/canonical_cert/perf_synthetic_user.mjs create   -> creates + onboards + signs in, writes
 *                                                                    .canonical-cert/perf-user-state.json
 *   node scripts/canonical_cert/perf_synthetic_user.mjs cleanup  -> deletes every row this created + the
 *                                                                    auth user, verifies 0 residue
 *
 * Email is prefixed `perfsc9-` and always ends `@fhip-synthetic.test` per the standing synthetic-account
 * convention. Uses the same signIn('mint') primitive the canonical-cert harness uses for its own fixture
 * users (lib/session.mjs), just without going through the range-restricted signin.mjs CLI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadDevEnv, serviceClient } from './lib/env.mjs';
import { signIn, revoke } from './lib/session.mjs';

const STATE_FILE = path.resolve('.canonical-cert', 'perf-user-state.json');

async function svc(method, path_, body, extraHeaders = {}) {
  const { url, serviceKey } = loadDevEnv();
  const r = await fetch(`${url}/rest/v1/${path_}`, { method, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', ...extraHeaders }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

async function create() {
  const { url, serviceKey } = loadDevEnv();
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `perfsc9-${stamp}@fhip-synthetic.test`;
  const r = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: `Perf9!${stamp}`, email_confirm: true }) });
  const j = await r.json();
  if (!j.id) throw new Error(`createUser failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  const patch = await svc('PATCH', `user_profiles?user_id=eq.${j.id}`, {
    full_name: 'SPD-14 Perf Check', country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true,
    employment_status: 'full_time_employed', profile_completion_percentage: 100,
    country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now,
  });
  if (patch.status >= 300) throw new Error(`profile patch failed (${patch.status}): ${patch.text.slice(0, 300)}`);
  const s = await signIn(email, { method: 'mint' });
  if (s.userId !== j.id) throw new Error('minted session id mismatch');
  const state = { userId: j.id, email };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`created + onboarded + signed in: ${email} (${j.id})`);
  console.log(`state -> ${STATE_FILE}`);
}

async function cleanup() {
  if (!fs.existsSync(STATE_FILE)) { console.log('no state file -- nothing to clean up'); return; }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const sb = await serviceClient();
  // Delete in FK-safe order: leaf evidence/allocation/link/correction rows, then transactions/statements/accounts.
  const uid = state.userId;
  const tables = [
    'fdh_transaction_allocations', 'fdh_transaction_links', 'fdh_transaction_corrections',
    'fdh_duplicate_candidates', 'fdh_review_items', 'fdh_classification_history',
    'fdh_transactions', 'fdh_statement_uploads', 'fdh_financial_accounts',
    'financial_snapshots',
  ];
  for (const t of tables) {
    const { error } = await sb.from(t).delete().eq('user_id', uid);
    if (error) console.log(`  delete ${t}: ${error.message}`);
  }
  try { await revoke(state.email, { scope: 'global' }); } catch (e) { console.log(`  revoke: ${e.message}`); }
  const { url, serviceKey } = loadDevEnv();
  await fetch(`${url}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  // Verify.
  let residual = 0;
  for (const t of tables) {
    const { count } = await sb.from(t).select('id', { count: 'exact', head: true }).eq('user_id', uid);
    residual += count ?? 0;
  }
  const userCheck = await fetch(`${url}/auth/v1/admin/users/${uid}`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  console.log(`CLEANUP: residual rows across ${tables.length} tables = ${residual}`);
  console.log(`CLEANUP: auth user lookup status = ${userCheck.status} (expect >= 400 / not found)`);
  fs.rmSync(STATE_FILE, { force: true });
  if (residual !== 0 || userCheck.status < 400) { console.error('CLEANUP INCOMPLETE'); process.exitCode = 1; }
}

const mode = process.argv[2];
if (mode === 'create') await create();
else if (mode === 'cleanup') await cleanup();
else { console.error('usage: perf_synthetic_user.mjs create|cleanup'); process.exitCode = 1; }
