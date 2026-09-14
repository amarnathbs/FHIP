/**
 * AIE-1 infrastructure-activation follow-on -- companion to
 * aiecl_failed_state_ui_live_dev_check.ts, same method. Covers TWO more
 * real instances of the same bug class, both confirmed live before their
 * fixes:
 *   - 'accepted_importing' (run.status 'accepted' or 'write_pending')
 *     with zero open items.
 *   - 'completed' with zero open items -- arguably the most commonly
 *     reached of all four gaps in real usage, since every successful
 *     acceptance eventually reaches this state permanently. This one
 *     evaded the EARLIER accessibility pass's own live-region check,
 *     which only verified the (always-present) live-region ELEMENT
 *     exists, never that it held any actual text -- fixed in this
 *     script's own assertion below too (checks non-empty text, not mere
 *     element presence).
 *
 * Run: npx tsx scripts/aiecl_accepted_importing_ui_live_dev_check.ts [baseUrl]
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
  else { failed++; console.log(`FAIL: ${label}` + (detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 1000)}` : '')); }
}

interface Scenario {
  key: 'accepted_importing' | 'completed';
  runStatus: 'write_pending' | 'completed';
  expectedContentPattern: RegExp;
}

const SCENARIOS: Scenario[] = [
  { key: 'accepted_importing', runStatus: 'write_pending', expectedContentPattern: /saving|importing|progress/i },
  { key: 'completed', runStatus: 'completed', expectedContentPattern: /saved|complete/i },
];

async function checkScenario(browser: Browser, scenario: Scenario): Promise<void> {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const email = `aiecl-${scenario.key}-${stamp}@example.com`;
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  let userId = '', intakeId = '', runId = '';
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`create user failed: ${created.error?.message}`);
    userId = created.data.user.id;
    await admin.from('user_profiles').update({ country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true }).eq('user_id', userId);

    const intake = await admin.from('aie_document_intake').insert({ user_id: userId, declared_mime_type: 'application/pdf', byte_size: 1000, storage_key: null, status: 'ready' }).select('id').single();
    if (intake.error) throw new Error(`intake insert failed: ${intake.error.message}`);
    intakeId = intake.data.id;
    const run = await admin.from('aie_extraction_run').insert({ intake_id: intakeId, user_id: userId, run_number: 1, status: scenario.runStatus }).select('id').single();
    if (run.error) throw new Error(`run insert failed: ${run.error.message}`);
    runId = run.data.id;

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(password);
    await Promise.all([page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30_000 }), page.getByTestId('login-submit').click()]);

    const apiResponse = await context.request.get(`${BASE}/api/aie/review/runs/${runId}`);
    const apiBody = await apiResponse.json();
    check(`[${scenario.key}] setup: the real API computes the expected userState for run.status=${scenario.runStatus}, zero items`, apiBody?.data?.summary?.userState === scenario.key, apiBody);

    await page.goto(`${BASE}/aie-review/${runId}`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
    const bodyText = await page.locator('body').innerText();
    console.log(`--- [${scenario.key}] rendered body text (post-header) ---`);
    console.log(JSON.stringify(bodyText));
    check(`[${scenario.key}] the real rendered page shows the expected message to the user`, scenario.expectedContentPattern.test(bodyText), bodyText);

    // Checks ACTUAL TEXT CONTENT, not mere element presence -- the
    // earlier accessibility pass's "count() > 0" check on this exact
    // selector passed even when the live region was empty, which is
    // precisely why the 'completed' gap evaded detection then.
    const liveRegionTexts = await page.locator('[role="status"], [role="alert"], [aria-live]').allInnerTexts();
    check(`[${scenario.key}] a live region has ACTUAL non-empty announced text (not just an empty element)`, liveRegionTexts.some((t) => t.trim().length > 0), liveRegionTexts);

    const axeResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    check(`[${scenario.key}] zero automated WCAG2A/AA violations on the fixed state`, axeResults.violations.length === 0, axeResults.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })));
  } finally {
    if (runId) await admin.from('aie_extraction_run').delete().eq('id', runId);
    if (intakeId) await admin.from('aie_document_intake').delete().eq('id', intakeId);
    if (userId) await admin.auth.admin.deleteUser(userId);

    const residueRun = runId ? await admin.from('aie_extraction_run').select('id').eq('id', runId).maybeSingle() : { data: null };
    const residueIntake = intakeId ? await admin.from('aie_document_intake').select('id').eq('id', intakeId).maybeSingle() : { data: null };
    const residueUser = userId ? await admin.auth.admin.getUserById(userId) : { data: { user: null } };
    check(`[${scenario.key}] ZERO RESIDUE: run gone`, !residueRun.data);
    check(`[${scenario.key}] ZERO RESIDUE: intake gone`, !residueIntake.data);
    check(`[${scenario.key}] ZERO RESIDUE: user gone`, !residueUser.data.user);
  }
}

async function main() {
  const browser = await chromium.launch();
  try {
    for (const scenario of SCENARIOS) {
      await checkScenario(browser, scenario);
    }
  } finally {
    await browser.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

main();
