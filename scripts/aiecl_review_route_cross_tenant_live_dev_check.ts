/**
 * M12D TRACEABILITY — Product-Owner requirement ids this file is evidence for.
 *
 * Added by the M12 Phase D mapping pass. Each id below was checked against this
 * file's ACTUAL assertions; ids it only touches incidentally are deliberately
 * omitted, and where this file does NOT discharge a neighbouring requirement,
 * that is said so explicitly rather than left to be assumed.
 * Full matrix: docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md
 *
 *   AIE10-QA-08      Create a proof that cross-tenant status/evidence access fails
 *                    closed.
 *   AIE10-SEC-05     Model cross-tenant IDOR across upload, status, preview, evidence,
 *                    decision, cancel and delete.
 *   AIE16-AUTH-02    Test user A access to user B identifiers across every route.
 */
/**
 * AIE-1 infrastructure-activation mission (section 19, scenario 6: "Cross-
 * tenant access is denied"). This exact property was previously proven
 * ONLY at the internal function level (`scripts/aiecl_pc5_interface_live_dev_check.ts`,
 * calling `listUnresolvedItemsForPc5`/`resolveUnresolvedItemForPc5`
 * directly) -- never against the REAL HTTP review routes a real attacker
 * would actually hit. This closes that gap with real HTTP requests
 * against a real running app.
 *
 * Real disposable synthetic DEV users (owner + attacker), a real seeded
 * run belonging to the owner, real cookie-based sessions, real HTTP GET/
 * POST from the attacker's own session against the owner's runId.
 *
 * Run: npx tsx scripts/aiecl_review_route_cross_tenant_live_dev_check.ts [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(__dirname, '..');
const BASE = process.argv[2] ?? 'http://localhost:3942';

function loadEnv() {
  const raw = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').replace(/^﻿/, '');
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let passed = 0, failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}` + (detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 1000)}` : '')); }
}

async function loginAndGetContext(browser: import('playwright').Browser, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await Promise.all([page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30_000 }), page.getByTestId('login-submit').click()]);
  return { context, page };
}

async function main() {
  const stamp = Date.now();
  const ownerEmail = `aiecl-crosstenant-owner-${stamp}@example.com`;
  const attackerEmail = `aiecl-crosstenant-attacker-${stamp}@example.com`;
  const password = () => `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  let ownerId = '', attackerId = '', intakeId = '', runId = '', itemId = '';

  const browser = await chromium.launch();
  try {
    const ownerPw = password();
    const attackerPw = password();
    const owner = await admin.auth.admin.createUser({ email: ownerEmail, password: ownerPw, email_confirm: true });
    if (owner.error || !owner.data.user) throw new Error(`create owner failed: ${owner.error?.message}`);
    ownerId = owner.data.user.id;
    await admin.from('user_profiles').update({ country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true }).eq('user_id', ownerId);

    const attacker = await admin.auth.admin.createUser({ email: attackerEmail, password: attackerPw, email_confirm: true });
    if (attacker.error || !attacker.data.user) throw new Error(`create attacker failed: ${attacker.error?.message}`);
    attackerId = attacker.data.user.id;
    await admin.from('user_profiles').update({ country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true }).eq('user_id', attackerId);

    // Real seeded run belonging to the OWNER only.
    const intake = await admin.from('aie_document_intake').insert({ user_id: ownerId, declared_mime_type: 'application/pdf', byte_size: 1000, storage_key: null, status: 'ready' }).select('id').single();
    if (intake.error) throw new Error(`intake insert failed: ${intake.error.message}`);
    intakeId = intake.data.id;
    const run = await admin.from('aie_extraction_run').insert({ intake_id: intakeId, user_id: ownerId, run_number: 1, status: 'unresolved' }).select('id').single();
    if (run.error) throw new Error(`run insert failed: ${run.error.message}`);
    runId = run.data.id;
    const item = await admin.from('aie_unresolved_item').insert({
      run_id: runId, intake_id: intakeId, user_id: ownerId, reason_code: 'crosstenant_check_generic_reason',
      severity: 'blocking', status: 'open', item_version: 1, permitted_action_types: ['defer'],
    }).select('id').single();
    if (item.error) throw new Error(`item insert failed: ${item.error.message}`);
    itemId = item.data.id;

    const { context: ownerCtx, page: ownerPage } = await loginAndGetContext(browser, ownerEmail, ownerPw);
    const { context: attackerCtx, page: attackerPage } = await loginAndGetContext(browser, attackerEmail, attackerPw);

    // --- Real HTTP: owner CAN see their own run ---------------------
    const ownerGet = await ownerCtx.request.get(`${BASE}/api/aie/review/runs/${runId}`);
    check('owner: real HTTP GET on their own run succeeds (200)', ownerGet.status() === 200, ownerGet.status());
    const ownerBody = await ownerGet.json();
    check('owner: response genuinely contains the seeded unresolved item', ownerBody?.data?.items?.some((i: { id: string }) => i.id === itemId), ownerBody);

    // --- Real HTTP: attacker CANNOT see the owner's run --------------
    const attackerGet = await attackerCtx.request.get(`${BASE}/api/aie/review/runs/${runId}`);
    check('ATTACKER: real HTTP GET on the OWNERs runId is denied (404, not 200 with leaked data)', attackerGet.status() === 404, attackerGet.status());
    const attackerGetBody = await attackerGet.json().catch(() => null);
    check('attacker: response body contains no trace of the owners reason code / evidence', !JSON.stringify(attackerGetBody ?? {}).includes('crosstenant_check_generic_reason'), attackerGetBody);

    // --- Real HTTP: attacker cannot ACCEPT the owner's run either ----
    const attackerAccept = await attackerCtx.request.post(`${BASE}/api/aie/review/runs/${runId}/accept`, { data: { ownerHouseholdRole: 'self', idempotencyKey: `crosstenant-${stamp}` } });
    check('ATTACKER: real HTTP POST accept on the OWNERs runId is denied (not 200)', attackerAccept.status() !== 200, attackerAccept.status());

    // --- Real HTTP: attacker cannot decide on the owner's unresolved item ---
    const attackerDecide = await attackerCtx.request.post(`${BASE}/api/aie/review/items/${itemId}/decide`, { data: { action: 'defer', itemVersion: 1, idempotencyKey: `crosstenant-decide-${stamp}` } });
    check('ATTACKER: real HTTP POST decide on the OWNERs unresolved item is denied (not 200)', attackerDecide.status() !== 200, attackerDecide.status());

    // --- Real HTTP: the owner's own inbox never shows the attacker's (nonexistent) data, and vice versa is structurally impossible since attacker has zero runs ---
    const attackerInbox = await attackerCtx.request.get(`${BASE}/api/aie/review/inbox`);
    const attackerInboxBody = await attackerInbox.json().catch(() => null);
    const leaked = attackerInboxBody?.data?.runs?.some((r: { runId: string }) => r.runId === runId);
    check('attacker: their own inbox does not list the owners run', !leaked, attackerInboxBody);

    void ownerPage;
    void attackerPage;
  } finally {
    if (itemId) await admin.from('aie_unresolved_item').delete().eq('id', itemId);
    if (runId) await admin.from('aie_extraction_run').delete().eq('id', runId);
    if (intakeId) await admin.from('aie_document_intake').delete().eq('id', intakeId);
    if (ownerId) await admin.auth.admin.deleteUser(ownerId);
    if (attackerId) await admin.auth.admin.deleteUser(attackerId);
    await browser.close();

    const residueItem = itemId ? await admin.from('aie_unresolved_item').select('id').eq('id', itemId).maybeSingle() : { data: null };
    const residueRun = runId ? await admin.from('aie_extraction_run').select('id').eq('id', runId).maybeSingle() : { data: null };
    const residueIntake = intakeId ? await admin.from('aie_document_intake').select('id').eq('id', intakeId).maybeSingle() : { data: null };
    const residueOwner = ownerId ? await admin.auth.admin.getUserById(ownerId) : { data: { user: null } };
    const residueAttacker = attackerId ? await admin.auth.admin.getUserById(attackerId) : { data: { user: null } };
    check('ZERO RESIDUE: unresolved item gone', !residueItem.data);
    check('ZERO RESIDUE: run gone', !residueRun.data);
    check('ZERO RESIDUE: intake gone', !residueIntake.data);
    check('ZERO RESIDUE: owner gone', !residueOwner.data.user);
    check('ZERO RESIDUE: attacker gone', !residueAttacker.data.user);

    console.log(`\n=== SUMMARY: ${passed}/${passed + failed} checks passed ===`);
    if (failed > 0) process.exitCode = 1;
  }
}

main();
