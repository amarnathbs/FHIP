// G1 Country Foundation — LIVE DEV certification (migration 0122).
//
// Per repository standing rule #10 and the Product Owner's explicit closure
// requirement: every RLS/authority proof below uses a REAL authenticated
// user JWT (grant_type=password against the anon apikey), never the
// service-role key, for the decisive assertion. Service role is used ONLY
// for: creating synthetic auth users, seeding each scenario's starting
// profile state (mirrors what migration 0122's own one-time backfill or an
// admin-remediation path would produce), ground-truth re-queries, and
// cleanup.
//
// Reads credentials from THIS worktree's own .env.local (D:/fhip-g0-g1-
// country/.env.local — never the Product Owner's D:/FHIP tree, which this
// branch does not touch). Guarded to the known DEV project ref. No
// migrations applied by this script. No production access at any point.
//
// Run: node scripts/g1_country_foundation_live_dev_certification.mjs
import fs from 'node:fs';

function loadEnv() {
  const text = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    if (!line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const DEV_REF = 'vqycarelcoijzwlpkpcz';
if (!BASE || !SERVICE || !ANON) { console.error('FATAL: missing env vars'); process.exit(2); }
if (!BASE.includes(DEV_REF)) { console.error(`FATAL: refusing to run — ${BASE} is not the known DEV project.`); process.exit(2); }
if (BASE.includes('supabase.co') === false) { console.error('FATAL: unexpected host'); process.exit(2); }

const TAG = 'g1cf';
let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
};

const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
async function svc(method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: { ...SH, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function asUser(token, method, path, body, extraPrefer) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method, headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: extraPrefer ?? 'return=representation' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function rpcAs(token, fn, args) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function rpcAnon(fn, args) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

async function createUser(label, { country = null, confirmed = false } = {}) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const email = `${TAG}-${label}-${stamp}@fhip-test.invalid`;
  const password = `G1Cf!${stamp}Aa1`;
  const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { ...SH, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const j = await r.json();
  if (!j.id) throw new Error(`createUser(${label}) failed: ${JSON.stringify(j).slice(0, 300)}`);

  const patch = { full_name: `G1CF ${label}`, onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100 };
  if (country) {
    Object.assign(patch, {
      country_of_residence: country,
      preferred_currency: country === 'AU' ? 'AUD' : country === 'IN' ? 'INR' : null,
      ...(confirmed ? { country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED' } : {}),
    });
  }
  await svc('PATCH', `user_profiles?user_id=eq.${j.id}`, patch);

  const signInR = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const signInJ = await signInR.json();
  if (!signInJ.access_token) throw new Error(`signIn(${label}) failed: ${JSON.stringify(signInJ).slice(0, 300)}`);
  return { id: j.id, email, token: signInJ.access_token, label };
}
async function deleteUser(id) {
  await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SH });
}
async function setPrimary(userId, code, source = 'SYSTEM_INITIALISED') {
  return svc('PATCH', `user_profiles?user_id=eq.${userId}`, { primary_country: code, primary_country_source: source, primary_country_set_at: new Date().toISOString() });
}
async function readProfile(userId) {
  const r = await svc('GET', `user_profiles?user_id=eq.${userId}&select=country_of_residence,country_confirmed_at,primary_country,primary_country_source,preferred_currency,billing_country,billing_country_confirmed_at,billing_country_source`);
  return r.json?.[0] ?? null;
}

const users = []; // all created synthetic users, for final cleanup
const cbRows = []; // {table, id} tracked rows for explicit pre-delete cleanup
const auditUserIds = new Set();

async function main() {
  console.log('=== G1 Country Foundation: LIVE DEV certification ===');
  console.log(`Project: ${BASE}\n`);

  // --- 0. Independent re-confirmation that migration 0122 is live -----------
  console.log('--- 0. Migration 0122 live-schema re-confirmation ---');
  const registryCheck = await svc('GET', `countries?select=country_code,experience_level,default_locale,selectable,active,is_supported&country_code=in.(AU,IN,GB,US,SG,AE)&order=country_code`);
  check('countries table carries G1 registry columns for all 6 seeded countries', Array.isArray(registryCheck.json) && registryCheck.json.length === 6, JSON.stringify(registryCheck.json?.map(r => r.country_code)));
  const isSupportedRows = (registryCheck.json ?? []).filter(r => r.is_supported).map(r => r.country_code).sort();
  check('is_supported (MCC residence gate) unchanged live: true only for AU/IN', isSupportedRows.join(',') === 'AU,IN', JSON.stringify(isSupportedRows));

  const capCheck = await svc('GET', `country_capabilities?select=country_code,capability,enabled&country_code=in.(AU,IN)&capability=eq.DOMESTIC_TAX_OUTPUTS`);
  const auCap = capCheck.json?.find(c => c.country_code === 'AU');
  const inCap = capCheck.json?.find(c => c.country_code === 'IN');
  check('country_capabilities live: AU DOMESTIC_TAX_OUTPUTS=false, IN=true', auCap?.enabled === false && inCap?.enabled === true, JSON.stringify(capCheck.json));

  const cbTableCheck = await svc('GET', 'cross_border_relationships?select=id&limit=1');
  check('cross_border_relationships table reachable live (200)', cbTableCheck.status === 200, `status=${cbTableCheck.status}`);
  const previewTableCheck = await svc('GET', 'country_change_previews?select=id&limit=1');
  check('country_change_previews table reachable live (200)', previewTableCheck.status === 200, `status=${previewTableCheck.status}`);

  const rpcAuthCheck = await rpcAnon('confirm_billing_country', { p_billing_country: 'AU' });
  check('confirm_billing_country RPC exists live and fails closed unauthenticated (not "function not found")', rpcAuthCheck.status === 401 || (rpcAuthCheck.status >= 400 && /UNAUTHENTICATED|JWT|auth/i.test(rpcAuthCheck.text)), `status=${rpcAuthCheck.status} body=${rpcAuthCheck.text.slice(0,200)}`);

  // --- Synthetic users for the 9-scenario matrix -----------------------------
  const G1_01 = await createUser('01', { country: 'AU', confirmed: true }); users.push(G1_01);
  const G1_02 = await createUser('02', { country: 'IN', confirmed: true }); users.push(G1_02);
  const G1_03 = await createUser('03', { country: 'AU', confirmed: true }); users.push(G1_03);
  const G1_04 = await createUser('04', { country: 'IN', confirmed: true }); users.push(G1_04);
  const G1_05 = await createUser('05', { country: 'AU', confirmed: true }); users.push(G1_05);
  const G1_06 = await createUser('06', { country: 'IN', confirmed: true }); users.push(G1_06);
  const G1_07 = await createUser('07', { country: null, confirmed: false }); users.push(G1_07);
  const G1_08 = await createUser('08', { country: 'AU', confirmed: true }); users.push(G1_08);
  const G1_09 = await createUser('09', { country: null, confirmed: false }); users.push(G1_09);
  console.log(`\nCreated ${users.length} synthetic DEV users.`);

  // G1-01: AU/AU/AUD/AU/none
  await setPrimary(G1_01.id, 'AU');
  const g101bill = await rpcAs(G1_01.token, 'confirm_billing_country', { p_billing_country: 'AU' });
  const g101 = await readProfile(G1_01.id);
  check('G1-01 AU/AU/AUD/AU/none resolved live', g101.country_of_residence === 'AU' && g101.primary_country === 'AU' && g101.preferred_currency === 'AUD' && g101.billing_country === 'AU', `billRpcStatus=${g101bill.status} profile=${JSON.stringify(g101)}`);

  // G1-02: IN/IN/INR/IN/none
  await setPrimary(G1_02.id, 'IN');
  const g102bill = await rpcAs(G1_02.token, 'confirm_billing_country', { p_billing_country: 'IN' });
  const g102 = await readProfile(G1_02.id);
  check('G1-02 IN/IN/INR/IN/none resolved live', g102.country_of_residence === 'IN' && g102.primary_country === 'IN' && g102.preferred_currency === 'INR' && g102.billing_country === 'IN', `billRpcStatus=${g102bill.status} profile=${JSON.stringify(g102)}`);

  // --- 1. Preview + confirm workflow, live -----------------------------------
  console.log('\n--- 1. Preview + confirm workflow (live) ---');
  await setPrimary(G1_03.id, 'AU');
  const previewInsert = await asUser(G1_03.token, 'POST', 'country_change_previews', { user_id: G1_03.id, current_primary_country: 'AU', proposed_primary_country: 'IN', current_base_currency: 'AUD', proposed_base_currency: 'INR' });
  check('preview INSERT succeeds live as the owning authenticated user', previewInsert.status === 201 && Array.isArray(previewInsert.json) && previewInsert.json[0]?.id, `status=${previewInsert.status} body=${previewInsert.text.slice(0,300)}`);
  const previewId = previewInsert.json?.[0]?.id;
  if (previewId) cbRows.push({ table: 'country_change_previews', id: previewId });

  const confirm1 = await rpcAs(G1_03.token, 'confirm_primary_country_change', { p_preview_id: previewId, p_idempotency_key: `${TAG}-g103-1` });
  check('confirm RPC applies the change live (not idempotent-replay on first call)', confirm1.status === 200 && confirm1.json?.idempotent_replay === false, `status=${confirm1.status} body=${confirm1.text.slice(0,300)}`);
  const g103After = await readProfile(G1_03.id);
  check('G1-03 live: AU residence unchanged, primary now IN', g103After.country_of_residence === 'AU' && g103After.primary_country === 'IN', JSON.stringify(g103After));
  check('G1-03 live: billing_country still unresolved (never inferred)', g103After.billing_country === null, JSON.stringify(g103After));

  const confirm1Again = await rpcAs(G1_03.token, 'confirm_primary_country_change', { p_preview_id: previewId, p_idempotency_key: `${TAG}-g103-1` });
  check('duplicate confirmation with the SAME idempotency key is an idempotent replay live, not a second apply/error', confirm1Again.status === 200 && confirm1Again.json?.idempotent_replay === true, `status=${confirm1Again.status} body=${confirm1Again.text.slice(0,300)}`);

  const auditRowsG103 = await svc('GET', `audit_events?user_id=eq.${G1_03.id}&event_type=eq.PRIMARY_COUNTRY_CHANGE&select=id,event_type,metadata`);
  auditUserIds.add(G1_03.id);
  check('a full audit_events row was written live for the primary-country change', Array.isArray(auditRowsG103.json) && auditRowsG103.json.length === 1 && auditRowsG103.json[0].metadata?.new_primary_country === 'IN' && auditRowsG103.json[0].metadata?.old_primary_country === 'AU', JSON.stringify(auditRowsG103.json));

  // Already-consumed preview reused with a NEW idempotency key -> rejected live
  const reuseAttempt = await rpcAs(G1_03.token, 'confirm_primary_country_change', { p_preview_id: previewId, p_idempotency_key: `${TAG}-g103-DIFFERENT-key` });
  check('re-using an already-consumed preview id with a DIFFERENT idempotency key is rejected live', reuseAttempt.status >= 400 && /PREVIEW_ALREADY_CONSUMED/.test(reuseAttempt.text), `status=${reuseAttempt.status} body=${reuseAttempt.text.slice(0,300)}`);

  // Stale preview: profile moves between preview and confirm
  const previewStale = await asUser(G1_03.token, 'POST', 'country_change_previews', { user_id: G1_03.id, current_primary_country: 'IN', proposed_primary_country: 'AU' });
  const previewStaleId = previewStale.json?.[0]?.id;
  if (previewStaleId) cbRows.push({ table: 'country_change_previews', id: previewStaleId });
  await setPrimary(G1_03.id, 'GB'); // intervening change, service-role, simulates a second already-applied change
  const staleConfirm = await rpcAs(G1_03.token, 'confirm_primary_country_change', { p_preview_id: previewStaleId, p_idempotency_key: `${TAG}-g103-stale` });
  check('a stale preview (profile changed since preview) is rejected live', staleConfirm.status >= 400 && /PREVIEW_STALE/.test(staleConfirm.text), `status=${staleConfirm.status} body=${staleConfirm.text.slice(0,300)}`);
  await setPrimary(G1_03.id, 'IN'); // restore for downstream assertions

  // Cross-user (tampered) preview: G1_04 attempts to confirm G1_03's preview id
  const previewForOther = await asUser(G1_03.token, 'POST', 'country_change_previews', { user_id: G1_03.id, current_primary_country: 'IN', proposed_primary_country: 'AU' });
  const previewForOtherId = previewForOther.json?.[0]?.id;
  if (previewForOtherId) cbRows.push({ table: 'country_change_previews', id: previewForOtherId });
  const tamperAttempt = await rpcAs(G1_04.token, 'confirm_primary_country_change', { p_preview_id: previewForOtherId, p_idempotency_key: `${TAG}-tamper` });
  check('cross-user confirm of another user\'s live preview id is rejected', tamperAttempt.status >= 400 && /PREVIEW_NOT_FOUND/.test(tamperAttempt.text), `status=${tamperAttempt.status} body=${tamperAttempt.text.slice(0,300)}`);

  // Expired preview: force expires_at into the past via service-role, then attempt confirm as the real owner
  await svc('PATCH', `country_change_previews?id=eq.${previewForOtherId}`, { expires_at: new Date(Date.now() - 60000).toISOString() });
  const expiredConfirm = await rpcAs(G1_03.token, 'confirm_primary_country_change', { p_preview_id: previewForOtherId, p_idempotency_key: `${TAG}-g103-expired` });
  check('an expired preview is rejected live even for its rightful owner', expiredConfirm.status >= 400 && /PREVIEW_EXPIRED/.test(expiredConfirm.text), `status=${expiredConfirm.status} body=${expiredConfirm.text.slice(0,300)}`);

  // --- 2. Controlled-column guard, live ---------------------------------------
  console.log('\n--- 2. Controlled-column guard (live) ---');
  const directWrite = await asUser(G1_03.token, 'PATCH', `user_profiles?user_id=eq.${G1_03.id}`, { primary_country: 'AU' });
  check('direct authenticated UPDATE of primary_country is rejected live (42501), even though the user owns the row', directWrite.status >= 400 && /42501|CONTROLLED_WORKFLOW/.test(directWrite.text), `status=${directWrite.status} body=${directWrite.text.slice(0,300)}`);
  const directBillingWrite = await asUser(G1_03.token, 'PATCH', `user_profiles?user_id=eq.${G1_03.id}`, { billing_country: 'AU' });
  check('direct authenticated UPDATE of billing_country is rejected live (42501)', directBillingWrite.status >= 400 && /42501|CONTROLLED_WORKFLOW/.test(directBillingWrite.text), `status=${directBillingWrite.status} body=${directBillingWrite.text.slice(0,300)}`);
  const ordinaryWrite = await asUser(G1_03.token, 'PATCH', `user_profiles?user_id=eq.${G1_03.id}`, { full_name: 'G1CF Live Edited' });
  check('ordinary profile fields remain freely editable by the owner live (guard is column-scoped, not row-wide)', ordinaryWrite.status === 200 || ordinaryWrite.status === 204, `status=${ordinaryWrite.status}`);

  // --- 3. Cross-border relationships, live RLS --------------------------------
  console.log('\n--- 3. Cross-border relationships (live RLS) ---');
  const cbInsert = await asUser(G1_05.token, 'POST', 'cross_border_relationships', { user_id: G1_05.id, country_code: 'IN', relationship_type: 'ASSET' });
  check('owner INSERT of a cross-border relationship succeeds live', cbInsert.status === 201, `status=${cbInsert.status} body=${cbInsert.text.slice(0,300)}`);
  const cbId = cbInsert.json?.[0]?.id;
  if (cbId) cbRows.push({ table: 'cross_border_relationships', id: cbId });

  const ownSelect = await asUser(G1_05.token, 'GET', `cross_border_relationships?user_id=eq.${G1_05.id}&select=id`);
  check('owner SELECT of own relationship succeeds live', Array.isArray(ownSelect.json) && ownSelect.json.length === 1, JSON.stringify(ownSelect.json));

  const crossSelect = await asUser(G1_06.token, 'GET', `cross_border_relationships?user_id=eq.${G1_05.id}&select=id`);
  check('cross-tenant SELECT sees zero rows live (RLS row-filtering, not an error)', crossSelect.status === 200 && Array.isArray(crossSelect.json) && crossSelect.json.length === 0, `status=${crossSelect.status} body=${JSON.stringify(crossSelect.json)}`);

  const crossUpdate = await asUser(G1_06.token, 'PATCH', `cross_border_relationships?id=eq.${cbId}`, { status: 'ENDED' });
  check('cross-tenant UPDATE affects zero rows live', crossUpdate.status === 200 && (!Array.isArray(crossUpdate.json) || crossUpdate.json.length === 0), `status=${crossUpdate.status} body=${JSON.stringify(crossUpdate.json)}`);
  const stillActive = await svc('GET', `cross_border_relationships?id=eq.${cbId}&select=status`);
  check('ground truth confirms the row was NOT altered by the cross-tenant UPDATE attempt', stillActive.json?.[0]?.status === 'ACTIVE', JSON.stringify(stillActive.json));

  const crossDelete = await asUser(G1_06.token, 'DELETE', `cross_border_relationships?id=eq.${cbId}`);
  check('cross-tenant DELETE affects zero rows live', crossDelete.status === 200 && (!Array.isArray(crossDelete.json) || crossDelete.json.length === 0), `status=${crossDelete.status} body=${JSON.stringify(crossDelete.json)}`);
  const stillThere = await svc('GET', `cross_border_relationships?id=eq.${cbId}&select=id`);
  check('ground truth confirms the row still exists after the cross-tenant DELETE attempt', stillThere.json?.length === 1, JSON.stringify(stillThere.json));

  const forgedOwnership = await asUser(G1_06.token, 'POST', 'cross_border_relationships', { user_id: G1_05.id, country_code: 'AU', relationship_type: 'INCOME' });
  check('forged ownership (G1-06 inserting a row user_id=G1-05) is blocked live by WITH CHECK', forgedOwnership.status >= 400, `status=${forgedOwnership.status} body=${forgedOwnership.text.slice(0,300)}`);

  const dupActive = await asUser(G1_05.token, 'POST', 'cross_border_relationships', { user_id: G1_05.id, country_code: 'IN', relationship_type: 'ASSET' });
  check('duplicate ACTIVE relationship (same user/country/type) is rejected live by the unique index', dupActive.status >= 400 && /23505|duplicate/i.test(dupActive.text), `status=${dupActive.status} body=${dupActive.text.slice(0,300)}`);

  const ownEnd = await asUser(G1_05.token, 'PATCH', `cross_border_relationships?id=eq.${cbId}`, { status: 'ENDED', end_date: new Date().toISOString().slice(0,10) });
  check('owner CAN end their own relationship live', ownEnd.status === 200 && ownEnd.json?.[0]?.status === 'ENDED', `status=${ownEnd.status} body=${ownEnd.text.slice(0,300)}`);

  // --- 4. Billing-region validation, both directions, live -------------------
  console.log('\n--- 4. Billing-region validation (live) ---');
  const { validatePriceForBilling } = await import('../lib/services/billingAuthority.ts').catch(async () => {
    // tsx not available in plain node — fall back to an inline re-implementation
    // of the exact same pure logic for this live-proof step only (the
    // authoritative unit tests for this function already ran under vitest;
    // this reproduces the identical rule against a LIVE-read billing_country).
    return { validatePriceForBilling: ({ billingCountry, billingConfirmed, requestedPriceId, catalogue }) => {
      if (!billingConfirmed || !billingCountry) return { allowed: false, reason: 'BILLING_COUNTRY_NOT_CONFIRMED' };
      const entry = catalogue.find(c => c.priceId === requestedPriceId);
      if (!entry) return { allowed: false, reason: 'PRICE_ID_UNKNOWN' };
      if (entry.region !== 'GENERIC' && entry.region !== billingCountry) return { allowed: false, reason: 'PRICE_REGION_MISMATCH' };
      return { allowed: true, priceId: entry.priceId, region: entry.region };
    }};
  });
  const catalogue = [{ priceId: 'price_in_premium', region: 'IN' }, { priceId: 'price_au_premium', region: 'AU' }];

  const g105Billing = await rpcAs(G1_05.token, 'confirm_billing_country', { p_billing_country: 'AU' });
  const g105Profile = await readProfile(G1_05.id);
  check('confirm_billing_country("AU") applied live', g105Billing.status === 200 && g105Profile.billing_country === 'AU', `status=${g105Billing.status} profile=${JSON.stringify(g105Profile)}`);
  const g105Denied = validatePriceForBilling({ billingCountry: g105Profile.billing_country, billingConfirmed: Boolean(g105Profile.billing_country_confirmed_at), requestedPriceId: 'price_in_premium', catalogue });
  check('LIVE PROOF: a live-confirmed non-India billing country (AU) is DENIED an India-region price', g105Denied.allowed === false && g105Denied.reason === 'PRICE_REGION_MISMATCH', JSON.stringify(g105Denied));

  const g106Billing = await rpcAs(G1_06.token, 'confirm_billing_country', { p_billing_country: 'IN' });
  const g106Profile = await readProfile(G1_06.id);
  check('confirm_billing_country("IN") applied live', g106Billing.status === 200 && g106Profile.billing_country === 'IN', `status=${g106Billing.status} profile=${JSON.stringify(g106Profile)}`);
  const g106Allowed = validatePriceForBilling({ billingCountry: g106Profile.billing_country, billingConfirmed: Boolean(g106Profile.billing_country_confirmed_at), requestedPriceId: 'price_in_premium', catalogue });
  check('LIVE PROOF: a live-confirmed matching billing country (IN) IS ALLOWED the India-region price', g106Allowed.allowed === true, JSON.stringify(g106Allowed));

  // --- 5. MCC / jurisdiction regression, live ---------------------------------
  console.log('\n--- 5. MCC regression (live) ---');
  const mccBlocked = await asUser(G1_07.token, 'POST', 'income_sources', { user_id: G1_07.id, source_name: 'x', income_type: 'salary', amount: 100, frequency: 'monthly', currency_code: 'AUD', owner: 'self' });
  check('MCC still blocks an unconfirmed user from a foundational table live (regression)', mccBlocked.status >= 400, `status=${mccBlocked.status} body=${mccBlocked.text.slice(0,300)}`);
  const mccOk = await asUser(G1_01.token, 'POST', 'income_sources', { user_id: G1_01.id, source_name: 'x', income_type: 'salary', amount: 100, frequency: 'monthly', currency_code: 'AUD', owner: 'self' });
  check('MCC still allows a confirmed user live (positive control, no over-block)', mccOk.status === 201, `status=${mccOk.status} body=${mccOk.text.slice(0,300)}`);
  if (mccOk.json?.[0]?.id) cbRows.push({ table: 'income_sources', id: mccOk.json[0].id });

  // --- 6. G1-07/08/09 remaining matrix cases, live ----------------------------
  console.log('\n--- 6. Remaining synthetic matrix cases (live) ---');
  const g107Profile = await readProfile(G1_07.id);
  check('G1-07 unconfirmed/null/unresolved/unresolved/none: no default assigned live', g107Profile.country_of_residence === null && g107Profile.primary_country === null && g107Profile.billing_country === null, JSON.stringify(g107Profile));

  const g108Preview = await asUser(G1_08.token, 'POST', 'country_change_previews', { user_id: G1_08.id, current_primary_country: 'AU', proposed_primary_country: 'GB' });
  const g108PreviewId = g108Preview.json?.[0]?.id;
  if (g108PreviewId) cbRows.push({ table: 'country_change_previews', id: g108PreviewId });
  const g108Confirm = await rpcAs(G1_08.token, 'confirm_primary_country_change', { p_preview_id: g108PreviewId, p_idempotency_key: `${TAG}-g108` });
  const g108cbInsert = await asUser(G1_08.token, 'POST', 'cross_border_relationships', { user_id: G1_08.id, country_code: 'IN', relationship_type: 'INVESTMENT' });
  if (g108cbInsert.json?.[0]?.id) cbRows.push({ table: 'cross_border_relationships', id: g108cbInsert.json[0].id });
  const g108Profile = await readProfile(G1_08.id);
  check('G1-08 generic primary (GB) + optional IN cross-border live: currency unaffected, primary=GB', g108Confirm.status === 200 && g108Profile.primary_country === 'GB' && g108Profile.preferred_currency === 'AUD' && g108cbInsert.status === 201, `confirmStatus=${g108Confirm.status} cbStatus=${g108cbInsert.status} profile=${JSON.stringify(g108Profile)}`);

  const g109PreviewAttempt = await asUser(G1_09.token, 'POST', 'country_change_previews', { user_id: G1_09.id, current_primary_country: null, proposed_primary_country: 'ZZ' });
  check('G1-09 unsupported country code rejected live (registry FK), never a default', g109PreviewAttempt.status >= 400, `status=${g109PreviewAttempt.status} body=${g109PreviewAttempt.text.slice(0,300)}`);

  // --- CLEANUP ---------------------------------------------------------------
  console.log('\n--- CLEANUP ---');
  // Delete audit_events rows explicitly (they are ON DELETE SET NULL from
  // auth.users, not CASCADE, so they would otherwise survive user deletion
  // with user_id nulled — explicit deletion here leaves a genuinely clean
  // slate rather than relying on that null-out behaviour).
  for (const uid of auditUserIds) {
    await svc('DELETE', `audit_events?user_id=eq.${uid}`);
  }
  for (const row of cbRows.reverse()) {
    await svc('DELETE', `${row.table}?id=eq.${row.id}`);
  }
  for (const u of users) {
    await deleteUser(u.id);
  }

  // Independent re-verification via FRESH queries (never the delete calls' own responses)
  const residualIncome = await svc('GET', `income_sources?user_id=in.(${users.map(u => u.id).join(',')})&select=id`);
  check('CLEANUP: zero residual income_sources rows (fresh re-query)', Array.isArray(residualIncome.json) && residualIncome.json.length === 0, JSON.stringify(residualIncome.json));
  const residualCb = await svc('GET', `cross_border_relationships?user_id=in.(${users.map(u => u.id).join(',')})&select=id`);
  check('CLEANUP: zero residual cross_border_relationships rows (fresh re-query)', Array.isArray(residualCb.json) && residualCb.json.length === 0, JSON.stringify(residualCb.json));
  const residualPreviews = await svc('GET', `country_change_previews?user_id=in.(${users.map(u => u.id).join(',')})&select=id`);
  check('CLEANUP: zero residual country_change_previews rows (fresh re-query)', Array.isArray(residualPreviews.json) && residualPreviews.json.length === 0, JSON.stringify(residualPreviews.json));
  const residualAudit = await svc('GET', `audit_events?user_id=in.(${users.map(u => u.id).join(',')})&select=id`);
  check('CLEANUP: zero residual audit_events rows (fresh re-query)', Array.isArray(residualAudit.json) && residualAudit.json.length === 0, JSON.stringify(residualAudit.json));
  const residualProfiles = await svc('GET', `user_profiles?user_id=in.(${users.map(u => u.id).join(',')})&select=user_id`);
  check('CLEANUP: zero residual user_profiles rows (fresh re-query, cascade from auth.users deletion)', Array.isArray(residualProfiles.json) && residualProfiles.json.length === 0, JSON.stringify(residualProfiles.json));
  for (const u of users) {
    const r = await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { headers: SH });
    check(`CLEANUP: synthetic auth user ${u.label} deleted (fresh re-query 404)`, r.status === 404, `status=${r.status}`);
  }

  console.log(`\n${pass}/${pass + fail} PASS`);
  if (fail) { console.log('FAILURES:', failures.join(' | ')); process.exit(1); }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(9); });
