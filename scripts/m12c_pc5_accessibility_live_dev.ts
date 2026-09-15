/**
 * M12D TRACEABILITY — Product-Owner requirement ids this file is evidence for.
 *
 * Added by the M12 Phase D mapping pass. Each id below was checked against this
 * file's ACTUAL assertions; ids it only touches incidentally are deliberately
 * omitted, and where this file does NOT discharge a neighbouring requirement,
 * that is said so explicitly rather than left to be assumed.
 * Full matrix: docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md
 *
 *   AIE15-A11Y-01    Semantic headings, landmarks and one clear page title — axe
 *                    wcag2a+wcag2aa, 0 violations across all seven states.
 *   AIE15-A11Y-02    Logical keyboard focus order — 37 tab stops, monotonic DOM order,
 *                    reaching "Save this answer".
 *   AIE15-A11Y-06    Announce processing/rechecking/success/failure through live
 *                    regions — verified against a REAL API failure surfacing in
 *                    role="alert".
 *   AIE16-REV-10     Test WCAG conformance.
 *   AIE15-A11Y-08    NOT discharged here. color-contrast returned INCOMPLETE (needs
 *                    human review) on all seven states (M12C-O12).
 *   AIE15-A11Y-12    NOT discharged here. No screen reader is installed or drivable in
 *                    this environment; live-region behaviour was verified
 *                    programmatically, which is not the same thing.
 */
/**
 * M12C §16 (`M5-OPEN-1`) — PC5 accessibility, for real, against a real running
 * app and real DEV data.
 *
 * ===========================================================================
 * SCOPE AND HONEST LIMITS — read these before reading the results
 * ===========================================================================
 * WHAT THIS IS. An automated axe-core audit (`@axe-core/playwright`, tags
 * `wcag2a` + `wcag2aa`) executed against the REAL rendered DOM of the REAL PC5
 * screens, served by a REAL `next dev` server, with a REAL authenticated
 * browser session, over REAL seeded rows in the DEV database. It follows the
 * pattern `scripts/aiecl_accessibility_live_dev_check.ts` established for the
 * AIE review UI rather than inventing a second one.
 *
 * WHAT THIS IS NOT. It is NOT a manual screen-reader pass. No screen reader
 * (NVDA/JAWS/VoiceOver/Orca) is available in this environment, and none was
 * simulated. That gap is reported as NOT AVAILABLE in the results and is not
 * dressed up as anything else. Automated tooling catches roughly a third of
 * WCAG issues; a clean axe run is evidence, not a certification.
 *
 * ANTI-VACUITY, BECAUSE A ZERO IS NOT A RESULT UNTIL THE HARNESS CAN PRODUCE A
 * NON-ZERO. Every state records `passes` (the number of axe rules that ran and
 * PASSED against real nodes) alongside `violations`. A state whose `passes` is
 * zero is reported as NOT MEASURED, never as a pass — a scan of a blank page
 * reports zero violations and means nothing. Each state additionally asserts a
 * known, state-specific element is on screen before the scan runs, so "the
 * page rendered the thing this state is named after" is proven rather than
 * assumed.
 *
 * STATES NOT REACHED ARE REPORTED AS NOT REACHED, with the reason, and never
 * silently omitted from the table.
 *
 * SAFETY. DEV ONLY. The target url is asserted to be the DEV project and
 * asserted NOT to equal `PRODUCTION_SUPABASE_URL` before any write. No
 * credential value is ever printed. Every seeded row is deleted in a `finally`
 * block and then INDEPENDENTLY re-queried to prove zero residue. Every
 * synthetic identifier is obviously fake.
 *
 * Run: npx tsx scripts/m12c_pc5_accessibility_live_dev.ts [baseUrl]
 * Requires a dev server started with AIE_REVIEW_PC5_PROJECTION_ENABLED=true.
 * NOTE: use `http://localhost:<port>`, not `http://127.0.0.1:<port>` — Next's
 * dev server blocks `/_next/webpack-hmr` as cross-origin from `127.0.0.1`,
 * which leaves the page unhydrated and every interaction dead. Found the hard
 * way on this pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(__dirname, '..');
const OUT_DIR = path.join(repoRoot, 'scripts', 'm12c-pc5-accessibility');
const BASE = process.argv[2] ?? 'http://localhost:3958';

// A NEXT_PUBLIC_ value, present in ~16 committed scripts. Not a secret.
const DEV_URL = 'https://vqycarelcoijzwlpkpcz.supabase.co';

function loadSharedEnv(): Record<string, string> {
  const candidate = [path.join(repoRoot, '.env.local'), 'D:/FHIP/.env.local'].find((p) => fs.existsSync(p));
  if (!candidate) throw new Error('no .env.local found (looked in the worktree and at D:/FHIP/.env.local)');
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}
const env = loadSharedEnv();

const PROD_URL = (env.PRODUCTION_SUPABASE_URL ?? '').replace(/\/$/, '');
if (PROD_URL && DEV_URL === PROD_URL) throw new Error('SAFETY ABORT: the DEV url equals PRODUCTION_SUPABASE_URL');
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY absent');
if (!env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY absent');

process.env.NEXT_PUBLIC_SUPABASE_URL = DEV_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

import { toAieCandidates } from '@/lib/aie/adapters/investment-intelligence/parserAdapter';
import { detectSource, parseDocumentWithParser } from '@/lib/services/investment-intelligence/parsers/registry';
import { II_ADAPTER_ID } from '@/lib/aie/adapters/investment-intelligence';
import { buildAieIiCasFixtureText } from '../tests/support/buildAieIiCasFixtureText';

const admin: SupabaseClient = createClient(DEV_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// Result recording
// ---------------------------------------------------------------------------
interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodeCount: number;
}
interface StateResult {
  key: string;
  label: string;
  reached: boolean;
  /** Why a state was not reached. Null when it was. */
  notReachedReason: string | null;
  url: string | null;
  /** The state-specific element that had to be on screen before scanning. */
  anchorAssertion: string | null;
  anchorFound: boolean | null;
  axePasses: number | null;
  axeIncomplete: number | null;
  /** Rule ids axe could not decide automatically — reported rather than
   * hidden, because "needs review" is not "passed". */
  incompleteRuleIds: string[];
  violations: AxeViolation[];
  byImpact: Record<string, number>;
  /** NOT MEASURED when axePasses === 0 — a scan with no passing rule proves
   * nothing about a zero violation count. */
  verdict: 'PASS' | 'VIOLATIONS' | 'NOT MEASURED' | 'NOT REACHED';
}
const states: StateResult[] = [];

interface KeyboardResult {
  key: string;
  label: string;
  exercised: boolean;
  passed: boolean | null;
  detail: string;
}
const keyboard: KeyboardResult[] = [];

/** The harness self-test: proof that a zero is a measurement, not a silence. */
let harnessNegativeControl: { ran: boolean; violationsWhenBroken: number; ruleIds: string[]; cleanAfterRemoval: boolean | null } = {
  ran: false,
  violationsWhenBroken: 0,
  ruleIds: [],
  cleanAfterRemoval: null,
};

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): boolean {
  if (ok) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 1200)}` : ''}`);
  }
  return ok;
}

function notReached(key: string, label: string, reason: string): void {
  states.push({
    key,
    label,
    reached: false,
    notReachedReason: reason,
    url: null,
    anchorAssertion: null,
    anchorFound: null,
    axePasses: null,
    axeIncomplete: null,
    incompleteRuleIds: [],
    violations: [],
    byImpact: {},
    verdict: 'NOT REACHED',
  });
  console.log(`NOT REACHED: ${label} -- ${reason}`);
}

/**
 * Scans one state. `anchor` is a locator-producing function for the element
 * that MUST be present for this state to be what it claims to be; the scan is
 * still run if it is missing, but the state is recorded as not-anchored and
 * the run fails, so a mislabelled screen cannot quietly contribute a clean
 * result.
 */
async function scanState(params: {
  page: Page;
  key: string;
  label: string;
  anchorDescription: string;
  anchorCount: () => Promise<number>;
}): Promise<void> {
  const { page, key, label } = params;
  const anchorFound = (await params.anchorCount()) > 0;
  check(`[${key}] anchor present on screen: ${params.anchorDescription}`, anchorFound);

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const violations: AxeViolation[] = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodeCount: v.nodes.length,
  }));
  const byImpact: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) {
    const k = v.impact ?? 'unknown';
    byImpact[k] = (byImpact[k] ?? 0) + v.nodeCount;
  }

  const axePasses = results.passes.length;
  // ANTI-VACUITY: a zero-violation result is only meaningful if rules actually
  // ran and passed against real nodes.
  const verdict: StateResult['verdict'] = axePasses === 0 ? 'NOT MEASURED' : violations.length === 0 ? 'PASS' : 'VIOLATIONS';

  states.push({
    key,
    label,
    reached: true,
    notReachedReason: null,
    url: page.url().replace(BASE, ''),
    anchorAssertion: params.anchorDescription,
    anchorFound,
    axePasses,
    axeIncomplete: results.incomplete.length,
    incompleteRuleIds: results.incomplete.map((i) => i.id),
    violations,
    byImpact,
    verdict,
  });

  check(`[${key}] axe actually ran against real content (passes > 0)`, axePasses > 0, { axePasses });
  check(`[${key}] zero automated WCAG2A/AA violations`, violations.length === 0, violations);
  console.log(`      ${label}: ${violations.length} violation(s), ${axePasses} rule(s) passed, ${results.incomplete.length} needs-review`);
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
const stamp = Date.now();
const created = { users: [] as string[] };

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  // The dev server compiles a route on first request; a click before React
  // hydrates submits the form natively and never signs in.
  await page.waitForTimeout(3000);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 90_000 });
}

async function seedRunWithItem(params: {
  userId: string;
  reasonCode: string;
  permittedActionTypes: string[];
  severity?: 'blocking' | 'warning';
  displayCandidate?: string | null;
  evidenceRef?: Record<string, unknown> | null;
}): Promise<{ intakeId: string; runId: string; itemId: string }> {
  const { userId } = params;
  const intake = await admin
    .from('aie_document_intake')
    .insert({
      user_id: userId,
      declared_mime_type: 'application/pdf',
      byte_size: 2048,
      storage_key: `zz-m12c-a11y/${userId}/${stamp}-${Math.random().toString(36).slice(2)}.bin`,
      status: 'ready',
      source_module_hint: 'investment_intelligence',
      display_filename: 'zz-synthetic-cas.pdf',
    })
    .select('id')
    .single();
  if (intake.error) throw new Error(`intake insert failed: ${intake.error.message}`);
  const intakeId = intake.data.id as string;

  const run = await admin
    .from('aie_extraction_run')
    .insert({ intake_id: intakeId, user_id: userId, run_number: 1, status: 'unresolved' })
    .select('id')
    .single();
  if (run.error) throw new Error(`run insert failed: ${run.error.message}`);
  const runId = run.data.id as string;

  const attempt = await admin.from('aie_parser_attempt').insert({
    run_id: runId,
    intake_id: intakeId,
    user_id: userId,
    adapter_id: II_ADAPTER_ID,
    outcome: 'complete',
    parser_version: 'm12c-a11y-1',
  });
  if (attempt.error) throw new Error(`parser_attempt insert failed: ${attempt.error.message}`);

  const text = buildAieIiCasFixtureText();
  const detection = detectSource(text);
  if (!detection.parser) throw new Error('the synthetic CAS fixture was not claimed by any certified parser');
  const parsed = parseDocumentWithParser(detection.parser, text);
  const rows = toAieCandidates(parsed).map((c) => ({
    run_id: runId,
    intake_id: intakeId,
    user_id: userId,
    field_name: c.fieldName,
    value_raw: c.valueRaw,
    is_null: c.isNull,
    source_method: c.sourceMethod,
    source_reference: c.sourceReference ?? null,
  }));
  const ci = await admin.from('aie_field_candidate').insert(rows);
  if (ci.error) throw new Error(`field_candidate insert failed: ${ci.error.message}`);

  const item = await admin
    .from('aie_unresolved_item')
    .insert({
      run_id: runId,
      intake_id: intakeId,
      user_id: userId,
      reason_code: params.reasonCode,
      severity: params.severity ?? 'blocking',
      status: 'open',
      display_candidate: params.displayCandidate ?? null,
      evidence_ref: params.evidenceRef ?? null,
      permitted_action_types: params.permittedActionTypes,
    })
    .select('id')
    .single();
  if (item.error) throw new Error(`unresolved_item insert failed: ${item.error.message}`);
  return { intakeId, runId, itemId: item.data.id as string };
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`\n=== M12C §16 (M5-OPEN-1) — PC5 accessibility, live DEV — ${new URL(DEV_URL).host} — ${new Date().toISOString()} ===`);
  console.log(`app under test: ${BASE}\n`);

  // 0153 must be on DEV for the PC5 decision path (it writes the three
  // `aie_review_decision` columns). Probed rather than assumed, with a
  // negative control that proves the probe can report absence.
  const allocProbe = await admin.from('ii_ownership_allocation').select('id').limit(1);
  const colProbe = await admin.from('aie_review_decision').select('original_value_at_decision').limit(1);
  const negProbe = await admin.from('aie_review_decision').select('zz_no_such_column_m12c').limit(1);
  check('NEGATIVE CONTROL — the schema probe can report a column as ABSENT', Boolean(negProbe.error), negProbe.error?.code);
  const has0153 = !allocProbe.error && !colProbe.error;
  check('migration 0153 is applied to DEV (ii_ownership_allocation + the three decision columns)', has0153, {
    ii_ownership_allocation: allocProbe.error?.code ?? 'PRESENT',
    'aie_review_decision.original_value_at_decision': colProbe.error?.code ?? 'PRESENT',
  });

  const email = `zz-m12c-a11y-${stamp}@fhip-test.invalid`;
  const password = `ZzM12c-${Math.random().toString(36).slice(2)}-Aa1!`;
  const createdUser = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createdUser.error || !createdUser.data.user) throw new Error(`createUser failed: ${createdUser.error?.message}`);
  const userId = createdUser.data.user.id;
  created.users.push(userId);

  await admin
    .from('user_profiles')
    .update({
      country_of_residence: 'IN',
      country_confirmed_at: new Date().toISOString(),
      country_source: 'USER_CONFIRMED',
      onboarding_completed: true,
    })
    .eq('user_id', userId);

  const household = await admin
    .from('households')
    .insert({ user_id: userId, household_name: `ZZ Synthetic M12C a11y ${stamp}`, primary_country: 'IN' })
    .select('id')
    .single();
  if (household.error) throw new Error(`household insert failed: ${household.error.message}`);
  const householdId = household.data.id as string;

  const addMember = async (fullName: string, relationship: string) => {
    const r = await admin
      .from('household_members')
      .insert({ user_id: userId, household_id: householdId, full_name: fullName, relationship, is_active: true })
      .select('id')
      .single();
    if (r.error) throw new Error(`household_members insert failed: ${r.error.message}`);
    return r.data.id as string;
  };
  const selfMemberId = await addMember('ZZ Synthetic Selfholder', 'self');
  const spouseMemberId = await addMember('ZZ Synthetic Spouseholder', 'spouse');

  const account = await admin
    .from('ii_accounts')
    .insert({
      user_id: userId,
      country_code: 'IN',
      currency_code: 'INR',
      status: 'active',
      account_type: 'mf_folio',
      institution_name: 'ZZ Synthetic Mutual Fund',
      folio_number: '9999000011',
    })
    .select('id')
    .single();
  if (account.error) throw new Error(`ii_accounts insert failed: ${account.error.message}`);
  const accountId = account.data.id as string;

  // Four independent runs, so resolving one cannot disturb the others.
  const ownerCase = await seedRunWithItem({
    userId,
    reasonCode: 'ii_adapter:owner_unresolved',
    permittedActionTypes: ['choose_value', 'reject_document', 'request_reprocessing', 'defer'],
    evidenceRef: { candidateMemberIds: [] },
  });
  const duplicateCase = await seedRunWithItem({
    userId,
    reasonCode: 'ii_adapter_duplicate_overlap:folio',
    permittedActionTypes: ['choose_value', 'reject_document', 'defer'],
  });
  const overlayCase = await seedRunWithItem({
    userId,
    reasonCode: 'ii_adapter:owner_unresolved',
    permittedActionTypes: ['choose_value', 'reject_document', 'defer'],
    displayCandidate: 'ZZ S••••••• H•••••',
  });
  const resolveCase = await seedRunWithItem({
    userId,
    reasonCode: 'ii_adapter:owner_unresolved',
    permittedActionTypes: ['choose_value', 'reject_document', 'defer'],
    evidenceRef: { candidateMemberIds: [] },
  });

  console.log(`seeded user ${userId.slice(0, 8)}; items: owner ${ownerCase.itemId.slice(0, 8)}, duplicate ${duplicateCase.itemId.slice(0, 8)}, overlay ${overlayCase.itemId.slice(0, 8)}, resolve ${resolveCase.itemId.slice(0, 8)}\n`);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, email, password);
    check('a real authenticated browser session was established via /login', true);

    const gotoAndSettle = async (url: string) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(1500);
    };

    // =====================================================================
    // STATE 1 — the resolution centre, with blocking items outstanding
    // =====================================================================
    await gotoAndSettle(`${BASE}/investment-intelligence/resolutions`);
    await page.getByText('We could not confirm who owns this investment account.').first().waitFor({ state: 'visible', timeout: 30_000 });
    await scanState({
      page,
      key: 'resolution_centre',
      label: 'Resolution centre (listing, blocking items outstanding)',
      anchorDescription: 'the listing renders at least one item question',
      anchorCount: () => page.getByText('We could not confirm who owns this investment account.').count(),
    });

    // =====================================================================
    // STATE 2 — the owner choice
    // =====================================================================
    await gotoAndSettle(`${BASE}/investment-intelligence/resolutions/${ownerCase.itemId}`);
    const ownerRadio = page.locator(`input[type="radio"][name="pc5-choice"][value="${selfMemberId}"]`);
    await ownerRadio.waitFor({ state: 'attached', timeout: 30_000 });
    await scanState({
      page,
      key: 'owner_choice',
      label: 'Owner choice (radio group of household members)',
      anchorDescription: 'a radio option exists for the "self" household member',
      anchorCount: () => ownerRadio.count(),
    });

    // =====================================================================
    // STATE 6 — blocking-unresolved state. Scanned HERE because it is a
    // property of this same rendered page: a blocking item must refuse
    // dismissal and say so. Asserted before scanning so the state is real.
    // =====================================================================
    const cannotHide = page.getByText('This one cannot be hidden — it blocks importing the statement.');
    await scanState({
      page,
      key: 'blocking_unresolved',
      label: 'Blocking-unresolved state (dismissal refused, statement still blocked)',
      anchorDescription: 'the screen states this item cannot be hidden because it blocks the statement',
      anchorCount: () => cannotHide.count(),
    });

    // =====================================================================
    // STATE 3 — joint allocation
    // =====================================================================
    check('the spouse is offered as a second owner, so "joint" is a real choice', (await page.locator(`input[type="radio"][name="pc5-choice"][value="${spouseMemberId}"]`).count()) > 0);
    await page.locator('input[type="radio"][name="pc5-choice"][value="joint"]').check();
    await page.getByText('Who owns which share?').waitFor({ state: 'visible', timeout: 15_000 });
    const allocationInputs = await page.locator('input[type="number"]').count();
    check('the joint allocation editor renders one percentage input per owner', allocationInputs >= 2, allocationInputs);
    await scanState({
      page,
      key: 'joint_allocation',
      label: 'Joint allocation editor (percentage split across owners)',
      anchorDescription: 'the "Who owns which share?" editor with per-owner percentage inputs',
      anchorCount: async () => (await page.locator('input[type="number"]').count()) > 0 ? page.getByText('Who owns which share?').count() : 0,
    });

    // =====================================================================
    // STATE 4 — duplicate decision
    // =====================================================================
    await gotoAndSettle(`${BASE}/investment-intelligence/resolutions/${duplicateCase.itemId}`);
    const dupOption = page.locator('input[type="radio"][name="pc5-choice"][value="same_economic_event"]');
    await dupOption.waitFor({ state: 'attached', timeout: 30_000 });
    await scanState({
      page,
      key: 'duplicate_decision',
      label: 'Duplicate decision (same event / separate events / wrong statement)',
      anchorDescription: 'the three closed-vocabulary duplicate answers are offered as radios',
      anchorCount: async () => page.locator('input[type="radio"][name="pc5-choice"]').count(),
    });

    // =====================================================================
    // KEYBOARD TESTS — driven with real key presses on the duplicate screen
    // (a radio group with three options and a disabled-until-chosen submit).
    // =====================================================================
    // K2 — radio group arrow-key behaviour.
    await page.locator('input[type="radio"][name="pc5-choice"]').first().focus();
    const beforeArrow = await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value ?? null);
    await page.keyboard.press('ArrowDown');
    const afterArrow = await page.evaluate(() => ({
      value: (document.activeElement as HTMLInputElement | null)?.value ?? null,
      checked: (document.activeElement as HTMLInputElement | null)?.checked ?? null,
    }));
    const radioOk = beforeArrow !== null && afterArrow.value !== null && afterArrow.value !== beforeArrow && afterArrow.checked === true;
    keyboard.push({
      key: 'radio_groups',
      label: 'Radio groups — arrow keys move focus AND selection within the group',
      exercised: true,
      passed: radioOk,
      detail: `ArrowDown moved focus from "${beforeArrow}" to "${afterArrow.value}" (checked=${afterArrow.checked})`,
    });
    check('KEYBOARD — arrow keys move selection within the pc5-choice radio group', radioOk, { beforeArrow, afterArrow });

    // K1 — focus order. Tab from the top of the document and record the
    // sequence, then assert it is in DOM order and reaches the submit button.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    const focusSequence: Array<{ tag: string; text: string; domIndex: number }> = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const snap = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const all = Array.from(document.querySelectorAll('*'));
        return {
          tag: el.tagName,
          text: (el.textContent ?? el.getAttribute('aria-label') ?? (el as HTMLInputElement).value ?? '').trim().slice(0, 40),
          domIndex: all.indexOf(el),
        };
      });
      if (snap) focusSequence.push(snap);
      const done = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.includes('Discard this statement…') ?? false);
      if (done) break;
    }
    const indices = focusSequence.map((f) => f.domIndex);
    const monotonic = indices.every((v, i) => i === 0 || v >= indices[i - 1]);
    const reachedSubmit = focusSequence.some((f) => f.tag === 'BUTTON' && f.text.includes('Save this answer'));
    keyboard.push({
      key: 'focus_order',
      label: 'Focus order — Tab traverses interactive elements in DOM order and reaches the primary action',
      exercised: true,
      passed: monotonic && reachedSubmit,
      detail: `${focusSequence.length} tab stops; DOM-order monotonic=${monotonic}; reached "Save this answer"=${reachedSubmit}`,
    });
    check('KEYBOARD — Tab order follows DOM order (no positive tabindex reordering)', monotonic, indices);
    check('KEYBOARD — Tab reaches the primary "Save this answer" action', reachedSubmit, focusSequence.map((f) => `${f.tag}:${f.text}`));

    // K3 — labels. Every focusable form control must have an accessible name.
    const labelAudit = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll('input, select, textarea')) as HTMLElement[];
      const unlabelled: string[] = [];
      for (const el of controls) {
        const id = el.getAttribute('id');
        const aria = el.getAttribute('aria-label');
        const labelledBy = el.getAttribute('aria-labelledby');
        const wrapping = el.closest('label');
        const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const named = Boolean(aria || labelledBy || wrapping || forLabel);
        if (!named) unlabelled.push(`${el.tagName}[type=${el.getAttribute('type') ?? '-'}][name=${el.getAttribute('name') ?? '-'}]`);
      }
      return { total: controls.length, unlabelled };
    });
    keyboard.push({
      key: 'labels',
      label: 'Labels — every form control has a programmatic accessible name',
      exercised: true,
      passed: labelAudit.total > 0 && labelAudit.unlabelled.length === 0,
      detail: `${labelAudit.total} control(s) inspected; ${labelAudit.unlabelled.length} without a name${labelAudit.unlabelled.length ? `: ${labelAudit.unlabelled.join(', ')}` : ''}`,
    });
    check('KEYBOARD — every form control on the decision screen has an accessible name', labelAudit.total > 0 && labelAudit.unlabelled.length === 0, labelAudit);

    // K5 — loading announcement. The API response is DELAYED on purpose so the
    // transient loading region is observable; without the delay the state
    // exists for a few milliseconds and a passing assertion would be luck.
    await page.route('**/api/pc5/resolutions/**', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    void page.goto(`${BASE}/investment-intelligence/resolutions/${ownerCase.itemId}`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    let loadingText: string | null = null;
    for (let i = 0; i < 60; i++) {
      loadingText = await page
        .locator('[role="status"][aria-live="polite"]')
        .first()
        .innerText()
        .catch(() => null);
      if (loadingText && /loading/i.test(loadingText)) break;
      await page.waitForTimeout(250);
    }
    const loadingOk = Boolean(loadingText && /loading/i.test(loadingText));
    keyboard.push({
      key: 'loading_announcements',
      label: 'Loading announcements — the load transition is inside a polite live region',
      exercised: true,
      passed: loadingOk,
      detail: loadingOk ? `role="status" aria-live="polite" announced: "${loadingText?.trim()}"` : 'no polite live region carrying a loading message was observed',
    });
    check('KEYBOARD/SR — the loading state is announced via role="status" aria-live="polite"', loadingOk, loadingText);
    await page.unroute('**/api/pc5/resolutions/**');

    // K4 — error announcement. A real failure, produced by asking the real API
    // for an item id this user does not own: the route answers 404 and the
    // component must surface it in a role="alert".
    await gotoAndSettle(`${BASE}/investment-intelligence/resolutions/00000000-0000-4000-8000-000000000000`);
    const alertText = await page
      .locator('[role="alert"]')
      .first()
      .innerText()
      .catch(() => null);
    const errorOk = Boolean(alertText && alertText.trim().length > 0);
    keyboard.push({
      key: 'error_announcements',
      label: 'Error announcements — a real API failure is surfaced in a role="alert"',
      exercised: true,
      passed: errorOk,
      detail: errorOk ? `role="alert" announced: "${alertText?.trim().slice(0, 160)}"` : 'no role="alert" region was rendered for a 404 item',
    });
    check('KEYBOARD/SR — a real 404 is announced in a role="alert" region', errorOk, alertText);

    // =====================================================================
    // STATE 7 (setup) + K6 — resolve an item for real, and assert the save
    // announcement. Both come from the same real click.
    // =====================================================================
    await gotoAndSettle(`${BASE}/investment-intelligence/resolutions/${resolveCase.itemId}`);
    const resolveRadio = page.locator(`input[type="radio"][name="pc5-choice"][value="${selfMemberId}"]`);
    await resolveRadio.waitFor({ state: 'attached', timeout: 30_000 });
    await resolveRadio.check();
    const decideResponse = page.waitForResponse(
      (r) => r.url().includes(`/api/pc5/resolutions/${resolveCase.itemId}/decide`) && r.request().method() === 'POST',
      { timeout: 90_000 },
    );
    await page.getByRole('button', { name: 'Save this answer' }).click();
    const decideRes = await decideResponse;
    check('a real PC5 decision was recorded over the real HTTP route (200)', decideRes.status() === 200, decideRes.status());
    await page.waitForTimeout(2500);
    const saveText = await page
      .locator('[role="status"]')
      .first()
      .innerText()
      .catch(() => null);
    const saveOk = Boolean(saveText && /Answer recorded/i.test(saveText));
    keyboard.push({
      key: 'save_announcements',
      label: 'Save announcements — the post-save confirmation is inside a role="status" region',
      exercised: true,
      passed: saveOk,
      detail: saveOk ? `role="status" announced: "${saveText?.trim().slice(0, 160)}"` : `observed: ${JSON.stringify(saveText)}`,
    });
    check('KEYBOARD/SR — the save confirmation is announced via role="status"', saveOk, saveText);

    // =====================================================================
    // STATE 5 — the correction overlay. Produced by a REAL acknowledge click
    // on the overlay case, then revisiting the screen.
    // =====================================================================
    await gotoAndSettle(`${BASE}/investment-intelligence/resolutions/${overlayCase.itemId}`);
    const ackButton = page.getByRole('button', { name: 'I have seen this' });
    await ackButton.waitFor({ state: 'visible', timeout: 30_000 });
    const ackResponse = page.waitForResponse(
      (r) => r.url().includes(`/api/pc5/resolutions/${overlayCase.itemId}/decide`) && r.request().method() === 'POST',
      { timeout: 90_000 },
    );
    await ackButton.click();
    const ackRes = await ackResponse;
    check('a real acknowledge decision was recorded (200) to populate the correction overlay', ackRes.status() === 200, ackRes.status());
    await gotoAndSettle(`${BASE}/investment-intelligence/resolutions/${overlayCase.itemId}`);
    const overlayHeading = page.getByText('What has been decided on this so far');
    const overlayVisible = await overlayHeading.count();
    if (overlayVisible > 0) {
      await scanState({
        page,
        key: 'correction_overlay',
        label: 'Correction overlay (what has been decided so far, with masking disclosure)',
        anchorDescription: 'the "What has been decided on this so far" decision history section',
        anchorCount: () => overlayHeading.count(),
      });
    } else {
      notReached('correction_overlay', 'Correction overlay (what has been decided so far)', 'the decision history section did not render after a real acknowledge decision');
    }

    // =====================================================================
    // STATE 7 — the resolved state, via the listing's own history toggle.
    // =====================================================================
    // Read the item's REAL terminal status first, so the badge asserted here
    // is the badge the product would correctly show, not the one the harness
    // hoped for. `toPc5Status` maps `resolved` -> "Resolved" and `superseded`
    // -> "Replaced by a newer check", and a PC5 re-reconciliation can legally
    // produce either.
    const resolvedRow = await admin.from('aie_unresolved_item').select('status').eq('id', resolveCase.itemId).maybeSingle();
    const terminalStatus = (resolvedRow.data?.status as string | undefined) ?? '(missing)';
    check('the resolved item reached a terminal status in the database', terminalStatus === 'resolved' || terminalStatus === 'superseded', terminalStatus);
    const expectedBadge = terminalStatus === 'superseded' ? 'Replaced by a newer check' : 'Resolved';

    await gotoAndSettle(`${BASE}/investment-intelligence/resolutions`);
    // BOTH toggles are required, and that is a real finding rather than a
    // harness quirk: "Show resolved history" widens the STATUS set
    // (`includeHistory`) but the request still carries the exception-only
    // `materialOnly` default, and `isMaterialForDefaultView` returns false for
    // every terminal status — so a resolved item is fetched and then filtered
    // straight back out. It is counted in "N lower-priority items are hidden",
    // which is the only visible clue. Recorded in the results table.
    await page.getByRole('button', { name: 'Show resolved history' }).click();
    await page.waitForTimeout(1500);
    const showAll = page.getByRole('button', { name: 'Show everything' });
    if ((await showAll.count()) > 0) {
      await showAll.click();
      await page.waitForTimeout(2500);
    }
    const resolvedBadge = page.getByText(expectedBadge, { exact: true });
    if ((await resolvedBadge.count()) > 0) {
      await scanState({
        page,
        key: 'resolved_state',
        label: `Resolved state (history view showing a terminal item, badge "${expectedBadge}")`,
        anchorDescription: `at least one item carries the "${expectedBadge}" status badge`,
        anchorCount: () => resolvedBadge.count(),
      });
    } else {
      notReached(
        'resolved_state',
        'Resolved state (history view showing a terminal item)',
        `no item rendered with the "${expectedBadge}" badge after a real resolution (database status was "${terminalStatus}")`,
      );
    }
    // =====================================================================
    // HARNESS NEGATIVE CONTROL — "do not trust a zero until the harness has
    // produced a non-zero". A deliberately broken node is injected into the
    // live page, axe is re-run, and the violation it MUST report is recorded;
    // the node is then removed and the page re-scanned to confirm it goes
    // clean again. Without this, every "0 violations" above would rest on the
    // assumption that the scanner would have spoken up.
    // =====================================================================
    await page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.id = 'zz-m12c-a11y-negative-control';
      // An image with no alt text and an input with no accessible name: two
      // of the most unambiguous WCAG2A failures there are.
      wrap.innerHTML =
        '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">' +
        '<input type="text">';
      document.body.appendChild(wrap);
    });
    const brokenScan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    harnessNegativeControl = {
      ran: true,
      violationsWhenBroken: brokenScan.violations.length,
      ruleIds: brokenScan.violations.map((v) => v.id),
      cleanAfterRemoval: null,
    };
    check(
      'HARNESS NEGATIVE CONTROL — axe reports violations when a deliberately broken node is injected',
      brokenScan.violations.length > 0,
      brokenScan.violations.map((v) => v.id),
    );
    await page.evaluate(() => document.getElementById('zz-m12c-a11y-negative-control')?.remove());
    const cleanScan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    harnessNegativeControl.cleanAfterRemoval = cleanScan.violations.length === 0;
    check(
      'HARNESS NEGATIVE CONTROL — the same page scans clean again once the broken node is removed',
      cleanScan.violations.length === 0,
      cleanScan.violations.map((v) => v.id),
    );
  } finally {
    await browser.close();

    // ------------------------------------------------------------------
    // Results files
    // ------------------------------------------------------------------
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const totals = states.reduce<Record<string, number>>((a, s) => {
      for (const [k, v] of Object.entries(s.byImpact)) a[k] = (a[k] ?? 0) + v;
      return a;
    }, {});
    const payload = {
      mission: 'M12C §16 — M5-OPEN-1, PC5 accessibility',
      ranAt: new Date().toISOString(),
      appUnderTest: BASE,
      database: new URL(DEV_URL).host,
      tool: '@axe-core/playwright, tags wcag2a + wcag2aa',
      screenReader: {
        status: 'NOT AVAILABLE',
        detail:
          'No screen reader (NVDA / JAWS / VoiceOver / Orca) is installed or drivable in this environment. No manual screen-reader pass was performed and none is claimed. The ARIA live-region behaviour below was verified programmatically (role/aria-live attributes and their rendered text), which is NOT the same as verifying what a screen reader actually announces.',
      },
      harnessNegativeControl,
      states,
      keyboard,
      violationTotalsByImpact: totals,
      checks: { passed, failed },
    };
    fs.writeFileSync(path.join(OUT_DIR, 'results.json'), `${JSON.stringify(payload, null, 2)}\n`);

    const lines: string[] = [];
    lines.push('# M12C §16 — PC5 accessibility (`M5-OPEN-1`)');
    lines.push('');
    lines.push(`Ran ${payload.ranAt} against ${BASE}, database \`${payload.database}\`.`);
    lines.push('Tool: `@axe-core/playwright`, tags `wcag2a` + `wcag2aa`, against the real rendered DOM of a real running app.');
    lines.push('');
    lines.push('## Automated axe results, per state');
    lines.push('');
    lines.push('| State | Reached | axe rules passed | Needs review | Violations | critical | serious | moderate | minor | Verdict |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const s of states) {
      lines.push(
        `| ${s.label} | ${s.reached ? 'yes' : '**NO**'} | ${s.axePasses ?? '—'} | ${s.axeIncomplete ?? '—'} | ${s.reached ? s.violations.length : '—'} | ${s.byImpact.critical ?? 0} | ${s.byImpact.serious ?? 0} | ${s.byImpact.moderate ?? 0} | ${s.byImpact.minor ?? 0} | ${s.verdict} |`,
      );
    }
    lines.push('');
    const incompleteIds = [...new Set(states.flatMap((s) => s.incompleteRuleIds))];
    if (incompleteIds.length > 0) {
      lines.push(`"Needs review" rule ids (axe could not decide these automatically; they are NOT passes): ${incompleteIds.map((i) => `\`${i}\``).join(', ')}.`);
      lines.push('');
    }
    lines.push('### Harness negative control — why the zeros above are a measurement');
    lines.push('');
    if (harnessNegativeControl.ran) {
      lines.push(
        `A deliberately broken node (an \`<img>\` with no alt text and an \`<input>\` with no accessible name) was injected into the live page and re-scanned: axe reported **${harnessNegativeControl.violationsWhenBroken} violation(s)** (${harnessNegativeControl.ruleIds.map((i) => `\`${i}\``).join(', ')}). The node was then removed and the same page scanned **${harnessNegativeControl.cleanAfterRemoval ? 'clean again' : 'NOT clean — investigate'}**. The scanner demonstrably speaks up when there is something to say.`,
      );
    } else {
      lines.push('**NOT RUN** — the zeros above rest on the anchor and `passes > 0` assertions only.');
    }
    lines.push('');
    const anyViolations = states.some((s) => s.violations.length > 0);
    lines.push('### Rule ids of every violation found');
    lines.push('');
    if (!anyViolations) {
      lines.push('None. No `wcag2a`/`wcag2aa` violation was reported on any state that was reached.');
      lines.push('');
      lines.push(
        'This zero is only meaningful because every reached state also reports a NON-ZERO "axe rules passed" count above — the scanner genuinely ran against real content, and each state additionally asserted a state-specific element was on screen before scanning. A state with zero passing rules would be recorded as NOT MEASURED, not as a pass.',
      );
    } else {
      for (const s of states) {
        if (s.violations.length === 0) continue;
        lines.push(`**${s.label}**`);
        lines.push('');
        lines.push('| rule id | impact | nodes | help |');
        lines.push('| --- | --- | ---: | --- |');
        for (const v of s.violations) lines.push(`| \`${v.id}\` | ${v.impact ?? 'unknown'} | ${v.nodeCount} | ${v.help} |`);
        lines.push('');
      }
    }
    lines.push('');
    const unreached = states.filter((s) => !s.reached);
    lines.push('### States not reached');
    lines.push('');
    if (unreached.length === 0) lines.push('None — all seven named states were reached and scanned.');
    else for (const s of unreached) lines.push(`- **${s.label}** — ${s.notReachedReason}`);
    lines.push('');
    lines.push('## Manual keyboard test');
    lines.push('');
    lines.push('Driven with real `Tab` / `ArrowDown` / `Enter`-equivalent key presses and real assertions on `document.activeElement`, live-region text and label association — not by reading code.');
    lines.push('');
    lines.push('| Item | Exercised | Result | Detail |');
    lines.push('| --- | --- | --- | --- |');
    for (const k of keyboard) {
      lines.push(`| ${k.label} | ${k.exercised ? 'yes' : '**no**'} | ${k.passed === null ? '—' : k.passed ? 'PASS' : '**FAIL**'} | ${k.detail} |`);
    }
    lines.push('');
    lines.push('## Screen-reader testing');
    lines.push('');
    lines.push('**NOT AVAILABLE.** ' + payload.screenReader.detail);
    lines.push('');
    fs.writeFileSync(path.join(OUT_DIR, 'results_table.md'), `${lines.join('\n')}\n`);
    console.log(`\nresults written to scripts/m12c-pc5-accessibility/{results.json,results_table.md}`);

    // ------------------------------------------------------------------
    // Cleanup + independent zero-residue re-query
    // ------------------------------------------------------------------
    console.log('\n--- cleanup ---');
    const u = created.users;
    if (u.length > 0) {
      await admin.from('ii_ownership_allocation').delete().in('user_id', u);
      await admin.from('ii_audit_events').delete().in('user_id', u);
      await admin.from('aie_audit_event').delete().in('user_id', u);
      await admin.from('aie_review_decision').delete().in('user_id', u);
      await admin.from('aie_unresolved_item').delete().in('user_id', u);
      await admin.from('aie_reconciliation_run').delete().in('user_id', u);
      await admin.from('aie_field_candidate').delete().in('user_id', u);
      await admin.from('aie_parser_attempt').delete().in('user_id', u);
      await admin.from('aie_processing_transition').delete().in('user_id', u);
      await admin.from('aie_ii_adapter_link').delete().in('user_id', u);
      await admin.from('aie_extraction_run').delete().in('user_id', u);
      await admin.from('aie_document_fingerprint').delete().in('user_id', u);
      await admin.from('aie_document_intake').delete().in('user_id', u);
      await admin.from('ii_accounts').delete().in('user_id', u);
      await admin.from('household_members').delete().in('user_id', u);
      await admin.from('households').delete().in('user_id', u);
      for (const id of u) await admin.auth.admin.deleteUser(id);
    }
    void accountId;

    const residue: Record<string, number> = {};
    for (const table of [
      'ii_ownership_allocation',
      'aie_review_decision',
      'aie_unresolved_item',
      'aie_reconciliation_run',
      'aie_field_candidate',
      'aie_parser_attempt',
      'aie_extraction_run',
      'aie_document_intake',
      'ii_accounts',
      'household_members',
      'households',
    ]) {
      const { count, error } = await admin.from(table).select('id', { count: 'exact', head: true }).in('user_id', u);
      if (error) continue;
      residue[table] = count ?? 0;
    }
    let usersRemaining = 0;
    for (const id of u) {
      const { data } = await admin.auth.admin.getUserById(id);
      if (data?.user) usersRemaining += 1;
    }
    const total = Object.values(residue).reduce((a, b) => a + b, 0) + usersRemaining;
    check('ZERO RESIDUE — every seeded row independently re-queried and absent', total === 0, { residue, usersRemaining });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
