// LR-9 — real, live-DEV, end-to-end account-deletion journey, driven through
// the ACTUAL Next.js API routes (not direct DB writes for the request/
// execute steps), per the PO's own required proof:
//   user request -> authorised Admin queue -> execute -> storage purge ->
//   auth.admin.deleteUser() -> DB cascade -> tombstone -> user cannot log
//   back in -> zero user financial/storage residue.
//
// Two disposable users: Admin A (granted a TEMPORARY
// admin_users.can_manage_account_deletions=true, revoked/deleted at the end
// -- never the operator's own account) and User B (the one actually
// deleted). Mirrors scripts/fdh4_anz_adapter_live_closure_check.ts's exact
// cookie-based real-HTTP-against-the-real-app pattern.
//
// Run: node scripts/lr9_account_deletion_live_dev_e2e.mjs [appBaseUrl]
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3000';
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(SUPA_URL).host.split('.')[0];
const admin = createClient(SUPA_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

const stamp = Date.now();
const results = [];
const check = (name, expected, actual) => { results.push({ name, expected, actual }); console.log(`[${JSON.stringify(expected) === JSON.stringify(actual) ? 'OK' : '!!'}] ${name} -> ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`); };

async function makeAuthedUser(tag) {
  const email = `lr9-e2e-${tag}-${stamp}@fhip-test.invalid`;
  const password = `Test-${stamp}-${tag}-Aa1!`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createErr) throw new Error(`createUser(${tag}) failed: ${createErr.message}`);
  const id = created.user.id;
  const tokRes = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await tokRes.json();
  if (!session?.access_token) throw new Error(`sign-in(${tag}) failed: ${JSON.stringify(session)}`);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, email, password, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

async function countryConfirm(userId) {
  const now = new Date().toISOString();
  const { error } = await admin.from('user_profiles').update({
    full_name: 'LR9 E2E', country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true,
    country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now,
  }).eq('user_id', userId);
  if (error) throw new Error(`country-confirm failed: ${error.message}`);
}

async function appPost(pathname, cookie, body) {
  const res = await fetch(`${APP}${pathname}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json };
}
async function appGet(pathname, cookie) {
  const res = await fetch(`${APP}${pathname}`, { headers: { Cookie: cookie } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json };
}

let uidA, uidB, storagePath;

try {
  console.log(`DEV project: ${new URL(SUPA_URL).host}`);
  console.log(`App under test: ${APP}\n`);

  // --- Setup: Admin A (temporary grant) and User B (the deletion subject) ---
  const admin_ = await makeAuthedUser('admin');
  const userB = await makeAuthedUser('userB');
  uidA = admin_.id; uidB = userB.id;
  await countryConfirm(uidA);
  await countryConfirm(uidB);

  const { error: grantErr } = await admin.from('admin_users').insert({ user_id: uidA, can_manage_account_deletions: true, notes: 'LR-9 E2E temporary grant, deleted at end of script' });
  if (grantErr) throw new Error(`admin grant failed: ${grantErr.message}`);
  console.log('Admin A granted can_manage_account_deletions (temporary).');

  // Real financial data for B, to prove genuine cascade deletion.
  const { data: assetRow, error: assetErr } = await admin.from('assets').insert({
    user_id: uidB, asset_name: 'LR9 E2E test asset', asset_class: 'cash', current_value: 1234.56, currency_code: 'AUD',
  }).select('id').single();
  if (assetErr) throw new Error(`seed asset failed: ${assetErr.message}`);
  const { data: expenseRow, error: expenseErr } = await admin.from('expense_items').insert({
    user_id: uidB, expense_name: 'LR9 E2E test expense', expense_category: 'other', amount: 88.00, frequency: 'monthly', currency_code: 'AUD',
  }).select('id').single();
  if (expenseErr) throw new Error(`seed expense failed: ${expenseErr.message}`);
  console.log('Seeded real financial rows for User B:', assetRow.id, expenseRow.id);

  // A real Storage object under B's prefix (one of the 3 buckets purgeAllUserStorage covers).
  // fdh-source-documents' REAL shape (lib/financial-data-hub/domain/uploadSession.ts's
  // buildOpaqueStorageKey, the sole writer): `${userId}/${documentId}/${documentId}.bin`
  // -- two levels deep, never a flat file directly under the user prefix. Bucket
  // config only allows [application/pdf, text/csv].
  const fakeDocumentId = 'e2e00000-0000-4000-8000-000000000001';
  storagePath = `${uidB}/${fakeDocumentId}/${fakeDocumentId}.bin`;
  const { error: uploadErr } = await admin.storage.from('fdh-source-documents').upload(storagePath, new Blob(['col1,col2\nLR-9,E2E disposable test content'], { type: 'text/csv' }), { contentType: 'text/csv' });
  if (uploadErr) throw new Error(`seed storage object failed: ${uploadErr.message}`);
  console.log('Seeded a real Storage object for User B:', storagePath);

  // --- Step 1: User B requests closure (real API route) ---
  const closeReq = await appPost('/api/account/close', userB.cookie, { reason: 'LR-9 E2E disposable test' });
  check('User B can submit a closure request', 200, closeReq.status);
  const requestId = closeReq.json?.data?.id;
  check('closure request comes back pending', 'pending', closeReq.json?.data?.status);
  console.log('Closure request id:', requestId);

  // --- Step 2: a non-admin (User B themself) cannot execute it ---
  const forbiddenExecute = await appPost(`/api/admin/account-deletions/${requestId}/execute`, userB.cookie);
  check('a non-admin (the requester themself) cannot execute the deletion', 403, forbiddenExecute.status);

  // --- Step 3: Admin A executes it (real API route, real orchestration) ---
  const exec = await appPost(`/api/admin/account-deletions/${requestId}/execute`, admin_.cookie);
  check('Admin A can execute the deletion', 200, exec.status);
  check('request finalized as completed', 'completed', exec.json?.data?.request?.status);
  check('tombstone: user_id set null on the completed request row', null, exec.json?.data?.request?.user_id);
  check('processed_by is Admin A', uidA, exec.json?.data?.request?.processed_by);
  check('storage purge reported zero errors', true, (exec.json?.data?.storageResults ?? []).every((r) => !r.error));
  console.log('Execute response:', JSON.stringify(exec.json?.data, null, 2));

  // --- Step 4: verify auth identity genuinely gone ---
  const { data: getUserResult, error: getUserErr } = await admin.auth.admin.getUserById(uidB);
  check('User B\'s auth identity is genuinely gone', true, !getUserResult?.user || !!getUserErr);

  // --- Step 5: verify DB cascade (financial rows genuinely gone, not just RLS-hidden) ---
  const { data: assetsAfter } = await admin.from('assets').select('id').eq('id', assetRow.id);
  check('seeded asset row cascade-deleted', 0, assetsAfter?.length ?? -1);
  const { data: expensesAfter } = await admin.from('expense_items').select('id').eq('id', expenseRow.id);
  check('seeded expense row cascade-deleted', 0, expensesAfter?.length ?? -1);

  // --- Step 6: verify Storage genuinely purged ---
  const { data: storageAfter } = await admin.storage.from('fdh-source-documents').list(uidB);
  check('User B\'s Storage prefix is empty after deletion', 0, storageAfter?.length ?? -1);

  // --- Step 7: User B cannot log back in ---
  const reLogin = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userB.email, password: userB.password }),
  });
  check('User B cannot sign in again after deletion', true, reLogin.status >= 400);

  const failed = results.filter((r) => JSON.stringify(r.expected) !== JSON.stringify(r.actual));
  console.log(`\n${results.length - failed.length}/${results.length} checks matched expected (LR-9 real end-to-end deletion journey) — ${failed.length} unexpected result(s).`);
  if (failed.length) process.exitCode = 1;
} finally {
  // Cleanup: Admin A's TEMPORARY grant + auth identity. User B is already
  // gone (that was the test itself) -- if the test failed partway and B
  // somehow still exists, this also cleans B up defensively.
  if (uidA) {
    try { await admin.from('admin_users').delete().eq('user_id', uidA); } catch { /* best-effort */ }
    try { await admin.auth.admin.deleteUser(uidA); } catch { /* best-effort */ }
  }
  if (uidB) { try { await admin.auth.admin.deleteUser(uidB); } catch { /* expected to already be gone */ } }
  if (storagePath) { try { await admin.storage.from('fdh-source-documents').remove([storagePath]); } catch { /* best-effort, expected already purged */ } }
  console.log('cleaned up Admin A (temporary grant + identity); User B already removed by the deletion itself.');
}
