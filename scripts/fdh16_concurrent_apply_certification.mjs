// FDH-16 Targeted Final Closure, item 5: a SAFE, genuine two-in-flight-
// simultaneous concurrent Apply test against a representative generic-bridge
// Apply RPC (fdh9_apply_income_proposal). FDH-15's own
// FDH15_IDEMPOTENCY_AND_CONCURRENCY_CERTIFICATION.md explicitly discloses
// this was "Not independently fault-injected as a genuine two-in-flight-
// simultaneously HTTP race" in any prior round (architectural analysis only:
// row-lock + compare-and-swap + a DB UNIQUE(proposal_id) constraint) — so
// there is no prior live evidence to reuse for this specific gate. This
// script performs the real thing: one synthetic user, one real 'ready'
// income proposal, two literally-simultaneous (Promise.all, same tick)
// authenticated RPC calls with identical parameters against real hosted DEV.
//
// Required result (spec item 5): canonical financial result = ONE (not
// duplicated); duplicate effect = 0.
//
// Does NOT touch or damage shared DEV infrastructure itself — only creates
// and tears down its own synthetic user/rows, exactly like every other
// FDH-16 script.
//
// Run: npx tsx scripts/fdh16_concurrent_apply_certification.mjs
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

const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
async function svc(method, path, body) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { method, headers: { ...SH, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body !== undefined ? JSON.stringify(body) : undefined });
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
async function insert(table, body, track) {
  const r = await svc('POST', table, body);
  const row = Array.isArray(r.json) ? r.json[0] : null;
  if (!row) throw new Error(`insert ${table} failed (${r.status}): ${r.text.slice(0, 500)}`);
  if (track) track.push({ table, id: row.id });
  return row;
}

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? ' :: ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`); }
};

async function createUser() {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `fdh16-concur-${stamp}@fhip-test.invalid`;
  const password = `Fdh16Concur!${stamp}`;
  const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { ...SH, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const j = await r.json();
  if (!j.id) throw new Error(`createUser failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = new Date().toISOString();
  await svc('PATCH', `user_profiles?user_id=eq.${j.id}`, { full_name: 'FDH16 Concurrent Apply Check', country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true, employment_status: 'full_time_employed', profile_completion_percentage: 100, country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now });
  const signInR = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const signInJ = await signInR.json();
  if (!signInJ.access_token) throw new Error(`signIn failed: ${JSON.stringify(signInJ).slice(0, 300)}`);
  return { id: j.id, email, token: signInJ.access_token };
}
async function deleteUser(id) { await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: SH }); }

const TAG = 'fdh16-concur';
const track = [];
const SALARY = 6500;

async function main() {
  console.log('=== FDH-16 CLOSURE item 5: concurrent Apply certification (fdh9_apply_income_proposal) ===');
  const U = await createUser();
  console.log(`Synthetic concurrent-apply user: ${U.email} (${U.id})`);
  try {
    const payroll = await insert('fdh_payroll_events', {
      user_id: U.id, country_code: 'AU', currency_code: 'AUD', net_pay: SALARY, gross_pay: 7600.25,
      pay_frequency: 'monthly', pay_frequency_source: 'stated_on_payslip', reconciliation_status: 'reconciled',
      bank_match_status: 'not_attempted', review_status: 'resolved', approval_status: 'approved', approved_at: new Date().toISOString(),
      payslip_fingerprint: `${TAG}-payslip-1`,
    }, track);
    const prop = await insert('fhip_import_proposals', {
      user_id: U.id, target_domain: 'income', source_kind: 'payslip', source_payroll_event_id: payroll.id,
      currency_code: 'AUD', target_entity_id: null, recommended_apply_mode: 'add_new', status: 'ready',
    }, track);
    await insert('fhip_import_proposal_fields', { user_id: U.id, proposal_id: prop.id, field_name: 'amount', value_kind: 'money', proposed_value: String(SALARY), existing_value: null }, track);
    await insert('fhip_import_proposal_fields', { user_id: U.id, proposal_id: prop.id, field_name: 'frequency', value_kind: 'text', proposed_value: 'monthly', existing_value: null }, track);
    await insert('fhip_import_proposal_fields', { user_id: U.id, proposal_id: prop.id, field_name: 'income_type', value_kind: 'text', proposed_value: 'salary', existing_value: null }, track);
    await insert('fhip_import_proposal_fields', { user_id: U.id, proposal_id: prop.id, field_name: 'currency_code', value_kind: 'text', proposed_value: 'AUD', existing_value: null }, track);
    await insert('fhip_import_proposal_fields', { user_id: U.id, proposal_id: prop.id, field_name: 'source_name', value_kind: 'text', proposed_value: 'Salary', existing_value: null }, track);

    console.log(`\n--- Proposal ${prop.id} status='ready'. Firing 2 GENUINELY SIMULTANEOUS authenticated fdh9_apply_income_proposal calls (Promise.all, same tick, identical params) ---`);
    const applyArgs = { p_proposal_id: prop.id, p_decision: 'add_new', p_selected_fields: ['amount', 'frequency', 'income_type', 'currency_code', 'source_name'] };
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([
      rpcAs(U.token, 'fdh9_apply_income_proposal', applyArgs),
      rpcAs(U.token, 'fdh9_apply_income_proposal', applyArgs),
    ]);
    console.log(`  both calls settled in ${Date.now() - t0}ms`);
    console.log(`  call A: status=${r1.status} ok=${r1.json?.ok} code=${r1.json?.code ?? ''} target=${r1.json?.target_entity_id ?? ''}`);
    console.log(`  call B: status=${r2.status} ok=${r2.json?.ok} code=${r2.json?.code ?? ''} target=${r2.json?.target_entity_id ?? ''}`);

    const results = [r1, r2];
    const succeeded = results.filter((r) => r.json?.ok === true);
    const rejectedAlready = results.filter((r) => r.json?.ok === false && r.json?.code === 'ALREADY_APPLIED');

    check('CONC-1: exactly one of the two simultaneous calls succeeded (ok:true)', succeeded.length === 1, `succeeded=${succeeded.length}`);
    check('CONC-2: exactly one of the two simultaneous calls was rejected as ALREADY_APPLIED (the row-lock + compare-and-swap serialized them, it did not silently double-apply)', rejectedAlready.length === 1, `rejected=${rejectedAlready.length} codes=${results.map((r) => r.json?.code).join(',')}`);

    const targetEntityId = succeeded[0]?.json?.target_entity_id;
    if (targetEntityId) track.push({ table: 'income_sources', id: targetEntityId });

    // Ground truth: exactly one application row, unique(proposal_id) enforced.
    const apps = (await svc('GET', `fhip_import_applications?proposal_id=eq.${prop.id}&select=id,target_entity_id`)).json ?? [];
    check('CONC-3 (DECISIVE): exactly 1 fhip_import_applications row for this proposal_id — no duplicate application row', apps.length === 1, `count=${apps.length} rows=${JSON.stringify(apps)}`);

    // Ground truth: exactly one canonical income_sources row for this user with this amount.
    const incomeRows = (await svc('GET', `income_sources?user_id=eq.${U.id}&select=id,amount,source_name`)).json ?? [];
    check('CONC-4 (DECISIVE): exactly 1 canonical income_sources row created — no duplicate salary record', incomeRows.length === 1, `count=${incomeRows.length} rows=${JSON.stringify(incomeRows)}`);
    check('CONC-5: the single canonical income row has the correct amount (not doubled, not corrupted)', incomeRows.length === 1 && Number(incomeRows[0].amount) === SALARY, `amount=${incomeRows[0]?.amount}`);

    // Ground truth: proposal itself landed on exactly one terminal state.
    const propAfter = (await svc('GET', `fhip_import_proposals?id=eq.${prop.id}&select=status`)).json?.[0];
    check('CONC-6: proposal status is now applied (single terminal state, not stuck/ambiguous)', propAfter?.status === 'applied', `status=${propAfter?.status}`);
  } finally {
    console.log('\n--- CLEANUP ---');
    for (const { table, id } of track.reverse()) {
      await svc('DELETE', `${table}?id=eq.${id}`);
    }
    await deleteUser(U.id);
    const residualApps = await svc('GET', `fhip_import_applications?user_id=eq.${U.id}&select=id`);
    const residualIncome = await svc('GET', `income_sources?user_id=eq.${U.id}&select=id`);
    const residualProp = await svc('GET', `fhip_import_proposals?user_id=eq.${U.id}&select=id`);
    const residualUser = await fetch(`${BASE}/auth/v1/admin/users/${U.id}`, { headers: SH });
    check('CLEANUP: 0 residual fhip_import_applications rows', Array.isArray(residualApps.json) && residualApps.json.length === 0, `rows=${residualApps.json?.length}`);
    check('CLEANUP: 0 residual income_sources rows', Array.isArray(residualIncome.json) && residualIncome.json.length === 0, `rows=${residualIncome.json?.length}`);
    check('CLEANUP: 0 residual fhip_import_proposals rows', Array.isArray(residualProp.json) && residualProp.json.length === 0, `rows=${residualProp.json?.length}`);
    check('CLEANUP: auth user deleted', residualUser.status >= 400, `status=${residualUser.status}`);
  }
  console.log(`\n${pass}/${pass + fail} PASS`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error('FATAL ERROR', e); process.exitCode = 1; });
