/**
 * AIE-1 infrastructure-activation follow-on (item 5: "complete supported-
 * adapter journeys and accessibility checks"). Extends
 * aiecl_accessibility_live_dev_check.ts's coverage (inbox empty state, run
 * detail unresolved/exception state) to the two states that script's own
 * report named as explicit remaining work: the SAME run-detail component
 * (components/aie/review/RunReviewPanel.tsx, confirmed by direct source
 * read to handle both 'unresolved' and 'awaiting_acceptance' as one
 * component, not separate routes) in its awaiting_acceptance and
 * post-acceptance/completed states.
 *
 * Drives a REAL Insurance HTTP journey (the one adapter with a real,
 * already-certified live-DEV journey to reuse) exactly as
 * aiecl_insurance_regression_live_dev.ts does, then axe-scans the browser's
 * OWN rendered page at each reached state -- not a mocked/static fixture.
 *
 * Run: npx tsx scripts/aiecl_accessibility_additional_states_live_dev.ts [baseUrl]
 * Requires: a running dev server for this exact worktree/branch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createClient } from '@supabase/supabase-js';
import { buildMinimalTextPdf } from '../tests/support/buildMinimalPdf';
import { buildAieInsuranceFixtureText } from '../tests/support/buildAieInsuranceFixtureText';

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

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}` + (detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 2000)}` : '')); }
}

async function main() {
  const stamp = Date.now();
  const email = `aiecl-a11y2-${stamp}@example.com`;
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  let userId = '';
  let intakeId = '';
  let runId = '';
  let policyId: string | null = null;

  const browser = await chromium.launch();
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`create user failed: ${created.error?.message}`);
    userId = created.data.user.id;
    await admin.from('user_profiles').update({ country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true }).eq('user_id', userId);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(password);
    await Promise.all([page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30_000 }), page.getByTestId('login-submit').click()]);

    // Real HTTP upload -- reuses the same certified Insurance clean-fixture
    // journey the regression script already proved live-DEV.
    const fixtureText = buildAieInsuranceFixtureText();
    const pdfBytes = buildMinimalTextPdf([fixtureText.split('\n')]);
    const intakeResp = await context.request.post(`${BASE}/api/aie/insurance/intake?owner=self&filename=policy-a11y2.pdf`, {
      data: pdfBytes,
      headers: { 'Content-Type': 'application/pdf' },
    });
    const intakeBody = await intakeResp.json();
    check('real HTTP intake reaches awaiting_acceptance (setup, not itself an a11y check)', intakeResp.status() === 200 && intakeBody?.data?.status === 'awaiting_acceptance', intakeBody);
    intakeId = intakeBody?.data?.intake_id;
    runId = intakeBody?.data?.run_id;

    // --- Screen: run detail in its REAL awaiting_acceptance state --------
    await page.goto(`${BASE}/aie-review/${runId}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
    const awaitingResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    check(
      'run detail page (REAL awaiting_acceptance state, reached via genuine HTTP journey): zero automated WCAG2A/AA violations',
      awaitingResults.violations.length === 0,
      awaitingResults.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })),
    );
    const acceptButtonReachable = await page.locator('body').evaluate(() => true); // page loaded; keyboard check below
    void acceptButtonReachable;
    let reachedInteractive = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const activeTag = await page.evaluate(() => document.activeElement?.tagName);
      if (activeTag && activeTag !== 'BODY') { reachedInteractive = true; break; }
    }
    check('awaiting_acceptance state: Tab key reaches a real interactive element', reachedInteractive);

    // --- Real accept via HTTP, then reload the SAME page for the -----------
    // completed state.
    const idempotencyKey = `aiecl-a11y2-${stamp}-accept`;
    const acceptResp = await context.request.post(`${BASE}/api/aie/review/runs/${runId}/accept`, { data: { ownerHouseholdRole: 'self', idempotencyKey } });
    const acceptBody = await acceptResp.json();
    check('real accept succeeds (setup, not itself an a11y check)', acceptResp.status() === 200 && acceptBody?.data?.accepted === true, acceptBody);
    policyId = acceptBody?.data?.insurancePolicyId ?? null;

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
    const completedResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    check(
      'run detail page (REAL completed/accepted state, reached via genuine HTTP acceptance): zero automated WCAG2A/AA violations',
      completedResults.violations.length === 0,
      completedResults.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })),
    );
    const completedLiveRegionCount = await page.locator('[role="status"], [role="alert"], [aria-live]').count();
    check('completed state: at least one live region exists for status announcements (e.g. acceptance confirmation)', completedLiveRegionCount > 0, completedLiveRegionCount);
  } finally {
    await browser.close();
    if (policyId) await admin.from('insurance_policies').delete().eq('id', policyId);
    await admin.from('aie_insurance_adapter_link').delete().eq('aie_intake_id', intakeId || '00000000-0000-0000-0000-000000000000');
    if (runId) await admin.from('aie_unresolved_item').delete().eq('run_id', runId);
    if (runId) await admin.from('aie_extraction_run').delete().eq('id', runId);
    if (intakeId) await admin.from('aie_document_intake').delete().eq('id', intakeId);
    if (userId) await admin.auth.admin.deleteUser(userId);

    const residuePolicy = policyId ? await admin.from('insurance_policies').select('id').eq('id', policyId).maybeSingle() : { data: null };
    const residueIntake = intakeId ? await admin.from('aie_document_intake').select('id').eq('id', intakeId).maybeSingle() : { data: null };
    const residueUser = userId ? await admin.auth.admin.getUserById(userId) : { data: { user: null } };
    check('ZERO RESIDUE: policy gone', !residuePolicy.data);
    check('ZERO RESIDUE: intake gone', !residueIntake.data);
    check('ZERO RESIDUE: user gone', !residueUser.data.user);

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

main();
