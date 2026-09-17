/**
 * AIE-1 infrastructure-activation follow-on (item 5: "complete supported-
 * adapter journeys and accessibility checks" -- specifically the
 * failure/retry state the accessibility report named as never exercised
 * at all, not even functionally).
 *
 * HYPOTHESIS FORMED BY READING components/aie/review/RunReviewPanel.tsx
 * DIRECTLY (not assumed): its render logic originally had exactly 3
 * branches -- ready_to_accept, exception-item-list, and 'processing' --
 * with NO branch for userState === 'import_failed' or
 * 'unable_to_process_safely' when items.length === 0. Confirmed live
 * (this script, first run): a run reaching that exact state rendered
 * NOTHING below the filename header -- no explanation, no live-region
 * announcement. FIXED the same session (a 4th render branch + a
 * live-region announcement effect) -- this script now also verifies the
 * fix against the real running app for BOTH failure states
 * ('import_failed': accepted, then the write failed; and
 * 'unable_to_process_safely': failed before ever reaching acceptance).
 *
 * Run: npx tsx scripts/aiecl_failed_state_ui_live_dev_check.ts [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
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
  else { failed++; console.log(`FAIL: ${label}` + (detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 1500)}` : '')); }
}

async function checkFailureState(
  browser: Browser,
  scenario: 'import_failed' | 'unable_to_process_safely',
): Promise<void> {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const email = `aiecl-failedstate-${scenario}-${stamp}@example.com`;
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  let userId = '';
  let intakeId = '';
  let runId = '';
  let writeBatchId = '';

  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`create user failed: ${created.error?.message}`);
    userId = created.data.user.id;
    await admin.from('user_profiles').update({ country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true }).eq('user_id', userId);

    const intake = await admin.from('aie_document_intake').insert({
      user_id: userId, declared_mime_type: 'application/pdf', byte_size: 1000, storage_key: null, status: 'ready',
    }).select('id').single();
    if (intake.error) throw new Error(`intake insert failed: ${intake.error.message}`);
    intakeId = intake.data.id;

    // Two distinct terminal-failure states, per
    // lib/aie/review/userState.ts read directly:
    //   'import_failed' -- run reached failed_terminal AND a real
    //     aie_write_batch row exists (hasWriteBatchForRun() true) --
    //     "accepted, then the write itself failed."
    //   'unable_to_process_safely' -- run reached failed_terminal with NO
    //     write_batch row at all -- "never got as far as acceptance."
    const run = await admin.from('aie_extraction_run').insert({
      intake_id: intakeId, user_id: userId, run_number: 1, status: 'failed_terminal',
    }).select('id').single();
    if (run.error) throw new Error(`run insert failed: ${run.error.message}`);
    runId = run.data.id;

    if (scenario === 'import_failed') {
      const batch = await admin.from('aie_write_batch').insert({
        run_id: runId, intake_id: intakeId, user_id: userId, target_module: 'other', status: 'failed',
        idempotency_key: `aiecl-failedstate-${stamp}`,
      }).select('id').single();
      if (batch.error) throw new Error(`write batch insert failed: ${batch.error.message}`);
      writeBatchId = batch.data.id;
    }
    // For 'unable_to_process_safely', deliberately NO write_batch row.

    // Deliberately NO aie_unresolved_item row in either scenario -- this
    // is the exact "items.length === 0" condition the hypothesis requires.

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(password);
    await Promise.all([page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30_000 }), page.getByTestId('login-submit').click()]);

    await page.goto(`${BASE}/aie-review/${runId}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);

    // Confirm the API itself really does compute the expected userState
    // for this exact DB state (not inferring it -- reading the real
    // response).
    const apiResponse = await context.request.get(`${BASE}/api/aie/review/runs/${runId}`);
    const apiBody = await apiResponse.json();
    check(`[${scenario}] setup: the real API computes the expected userState for this exact DB state`, apiBody?.data?.summary?.userState === scenario, apiBody);

    // The actual test: what does the real rendered page show?
    const bodyText = await page.locator('body').innerText();
    const mainContentText = bodyText.replace(/Review document/g, '').trim();
    console.log(`--- [${scenario}] rendered body text (post-header) ---`);
    console.log(JSON.stringify(mainContentText));

    const hasAnyFailureExplanation = /fail|error|could not|try again|contact|unable|something went wrong/i.test(mainContentText);
    check(`[${scenario}] the real rendered page shows an explanation to the user`, hasAnyFailureExplanation, mainContentText);

    const liveRegionText = await page.locator('[role="status"], [role="alert"], [aria-live]').allInnerTexts();
    check(`[${scenario}] a live region announces the failure state to assistive technology`, liveRegionText.some((t) => t.trim().length > 0), liveRegionText);

    const axeResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    check(`[${scenario}] zero automated WCAG2A/AA violations on the fixed failure state`, axeResults.violations.length === 0, axeResults.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })));
  } finally {
    if (writeBatchId) await admin.from('aie_write_batch').delete().eq('id', writeBatchId);
    if (runId) await admin.from('aie_extraction_run').delete().eq('id', runId);
    if (intakeId) await admin.from('aie_document_intake').delete().eq('id', intakeId);
    if (userId) await admin.auth.admin.deleteUser(userId);

    const residueBatch = writeBatchId ? await admin.from('aie_write_batch').select('id').eq('id', writeBatchId).maybeSingle() : { data: null };
    const residueRun = runId ? await admin.from('aie_extraction_run').select('id').eq('id', runId).maybeSingle() : { data: null };
    const residueIntake = intakeId ? await admin.from('aie_document_intake').select('id').eq('id', intakeId).maybeSingle() : { data: null };
    const residueUser = userId ? await admin.auth.admin.getUserById(userId) : { data: { user: null } };
    check(`[${scenario}] ZERO RESIDUE: write batch gone`, !residueBatch.data);
    check(`[${scenario}] ZERO RESIDUE: run gone`, !residueRun.data);
    check(`[${scenario}] ZERO RESIDUE: intake gone`, !residueIntake.data);
    check(`[${scenario}] ZERO RESIDUE: user gone`, !residueUser.data.user);
  }
}

async function main() {
  const browser = await chromium.launch();
  try {
    await checkFailureState(browser, 'import_failed');
    await checkFailureState(browser, 'unable_to_process_safely');
  } finally {
    await browser.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

main();
