// G8 bounded production acceptance matrix -- run against Deployment 184
// (commit 7cbfa15: app-review fixes + G2 live proofs + validation-leak
// sweep, all merged and pushed to main the same day). Covers what the
// existing g8_prod_full_activation_smoke_test.mjs (rerun separately,
// 16/16 unchanged) does NOT: G2 country-detection behavior now that its
// two env vars are live for the first time, and HTTP-level spot-checks for
// two of the newly-deployed app-review fixes (the Zod-leak fix, and the
// FDH-3 upload-status disclosure). Real HTTP against the real running app,
// real disposable synthetic production users, cleaned up + independently
// re-verified gone.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://twwpnltizhtjxhamyoxt.supabase.co';
const ANON_KEY = 'sb_publishable_pWgbqCKmXZBCbqOtMr23Cw_V_oM8cZy';
const SERVICE_KEY = process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
const APP_BASE = 'https://app.financialhealthplatform.com';

if (!SERVICE_KEY) { console.error('PRODUCTION_SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(1); }

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const stamp = Date.now();

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
}

const createdUserIds = [];

async function makeUser(tag, country) {
  const email = `g8-accept-${tag}-${stamp}@fhip-internal-test.invalid`;
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${tag}: ${error.message}`);
  const userId = data.user.id;
  createdUserIds.push(userId);

  await admin.from('user_profiles').update({
    country_of_residence: country,
    country_confirmed_at: new Date().toISOString(),
    country_source: 'USER_CONFIRMED',
  }).eq('user_id', userId);

  const { data: signInData, error: signInErr } = await createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
    .auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`signIn ${tag}: ${signInErr.message}`);

  const projectRef = new URL(SUPABASE_URL).host.split('.')[0];
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(signInData.session), 'utf8').toString('base64');
  const cookie = `sb-${projectRef}-auth-token=${cookieValue}`;
  return { userId, email, password, cookie };
}

async function appFetch(user, path, { method = 'GET', body, headers = {} } = {}) {
  const h = { ...headers };
  if (user) h.Cookie = user.cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(`${APP_BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, ok: res.ok, headers: res.headers, json, text };
}

async function main() {
  // ============================================================
  // Part A -- G2 country-detection behavior, unauthenticated, no test
  // header (G2_ALLOW_TEST_DETECTION_HEADER=false in production by design
  // -- this section deliberately never attempts to use it).
  // ============================================================
  const homeRes = await fetch(`${APP_BASE}/`);
  const cacheControl = homeRes.headers.get('cache-control') ?? '';
  check(
    'G2: landing page now serves dynamic (uncached) per the documented enabling-G2-forces-dynamic-rendering finding',
    /no-cache|no-store|must-revalidate/i.test(cacheControl),
    `Cache-Control: ${cacheControl || '(none)'}`
  );

  // Real cookie name/format from lib/services/landingCountryContext.ts:
  // LANDING_COOKIE_NAME='fhip_landing_country', value is base64url JSON
  // {v:2, country, source:'MANUAL', setAt} -- constructed here exactly as
  // serializeLandingCountryCookie() does, not guessed.
  const overridePayload = { v: 2, country: 'IN', source: 'MANUAL', setAt: new Date().toISOString() };
  const overrideCookieValue = Buffer.from(JSON.stringify(overridePayload), 'utf8').toString('base64url');
  const manualOverrideRes = await fetch(`${APP_BASE}/`, { headers: { Cookie: `fhip_landing_country=${overrideCookieValue}` } });
  const manualBody = await manualOverrideRes.text();
  check(
    'G2: manual cookie override tier reaches the page (200 OK with the override cookie set)',
    manualOverrideRes.status === 200,
    `status=${manualOverrideRes.status}`
  );
  // React SSR inserts a hydration-boundary comment (<!-- -->) between
  // adjacent text/expression nodes -- e.g. literally `₹<!-- -->99` in the
  // raw HTML -- so the check must tolerate that, not just whitespace.
  const INDIA_PRICE_RE = /₹(?:<!--\s*-->)?\s*99(?!\d)/;
  const AU_PRICE_RE = /A\$(?:<!--\s*-->)?\s*9\.99/;
  check(
    'G2: India-priced content appears when the manual override cookie selects India, and AU pricing is absent',
    INDIA_PRICE_RE.test(manualBody) && !AU_PRICE_RE.test(manualBody),
    'looked for ₹99/mo (India) and absence of A$9.99 (AU)'
  );

  const noOverrideRes = await fetch(`${APP_BASE}/`);
  const noOverrideBody = await noOverrideRes.text();
  check(
    'G2: default (no override) still serves a valid priced landing page',
    noOverrideRes.status === 200 && (AU_PRICE_RE.test(noOverrideBody) || INDIA_PRICE_RE.test(noOverrideBody)),
    `status=${noOverrideRes.status}`
  );

  // ============================================================
  // Part B -- app-review fix spot-checks (item 1: leak fix; item 2:
  // upload-status disclosure), against the real deployed routes.
  // ============================================================
  const user = await makeUser('reviewfix', 'AU');

  const badRetirement = await appFetch(user, '/api/retirement', {
    method: 'POST',
    body: { account_name: 'g8 accept test', current_balance: -5, currency_code: 'AUD', owner: 'self' },
  });
  check(
    'App-review item 1: invalid Retirement submission returns a friendly, non-technical message (not a raw Zod dump)',
    badRetirement.status === 422 && typeof badRetirement.json?.error === 'string' && !badRetirement.json.error.includes('"code":"invalid_type"'),
    JSON.stringify(badRetirement.json)
  );
  check(
    'App-review item 1: the friendly message names the actual invalid field',
    typeof badRetirement.json?.error === 'string' && /current balance/i.test(badRetirement.json.error),
    badRetirement.json?.error
  );

  const uploadStatus = await appFetch(user, '/api/financial-data-hub/upload-status');
  check(
    'App-review item 2: upload-status endpoint reachable and reports the correct (disabled) production state',
    uploadStatus.status === 200 && uploadStatus.json?.data?.enabled === false,
    JSON.stringify(uploadStatus.json)
  );

  // Confirm the badValidation sweep reached a second, unrelated route too
  // (spot-check, not exhaustive across all 59).
  const badExpense = await appFetch(user, '/api/expenses', {
    method: 'POST',
    body: { expense_name: '', amount: -1 },
  });
  check(
    'Validation-leak sweep: a second, unrelated route (expenses) also returns the friendly message, not a raw Zod dump',
    badExpense.status === 422 && typeof badExpense.json?.error === 'string' && !badExpense.json.error.includes('"code":'),
    JSON.stringify(badExpense.json)
  );
}

async function cleanupAndVerify() {
  console.log('\n--- CLEANUP ---');
  for (const userId of createdUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) console.error(`FAILED to delete user ${userId}: ${error.message}`);
  }
  let residue = 0;
  for (const userId of createdUserIds) {
    const { data } = await admin.auth.admin.getUserById(userId);
    if (data?.user) { residue++; console.error(`RESIDUE: user ${userId} still exists`); }
  }
  console.log(residue === 0 ? 'Zero residue confirmed.' : `${residue} RESIDUE ITEMS REMAIN.`);
}

try {
  await main();
} catch (e) {
  console.error('SCRIPT ERROR:', e.stack || e.message);
  fail++;
  failures.push('script-level exception: ' + e.message);
} finally {
  await cleanupAndVerify();
}

console.log(`\n=== SUMMARY: ${pass}/${pass + fail} checks passed ===`);
if (failures.length) console.log('FAILED:', failures);
process.exitCode = fail > 0 ? 1 : 0;
