/**
 * M12C §8.1 — SYNTHETIC REPRODUCTION of the PC4 owner-mapping operator action.
 *
 * ===========================================================================
 * WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT
 * ===========================================================================
 * The M12 dispatch requires the Product Owner's owner-mapping step to be
 * "verified end-to-end with a synthetic reproduction of the SAME scenario
 * shape (not the real production data)". This script is that reproduction.
 *
 * IT DRIVES THE REAL HTTP ROUTE THROUGH THE REAL UI. A real disposable DEV
 * user is created, signs in through `/login` with a real password in a real
 * Chromium session, and every state change below is produced by a real click
 * on the real `/investment-intelligence/resolutions` screens, which call
 * `GET /api/pc5/resolutions`, `GET /api/pc5/resolutions/{itemId}` and
 * `POST /api/pc5/resolutions/{itemId}/decide`. Nothing calls
 * `decidePc5Resolution` directly — that is the layer
 * `scripts/pc5_live_dev_matrix.ts` already covers, and covering it again
 * would not prove the operator's own journey works.
 *
 * SCENARIO SHAPE. Production's 17 blocked `ii_portfolio_truth_status` rows
 * carry `unresolved_owner`, and the three `ii_source_documents` behind them
 * have `owner_member_id = null`. The AIE-layer equivalent of exactly that
 * state is an `aie_unresolved_item` with reason code
 * `ii_adapter:owner_unresolved`, severity `blocking` — raised by
 * `unresolvedItemForOwnerUnresolved` for precisely the "no owner was named"
 * condition, and blocking acceptance through
 * `countItemsBlockingAcceptanceForRun`.
 *
 * THE HONEST BOUNDARY, STATED UP FRONT RATHER THAN DISCOVERED LATER. The
 * production documents were ingested through the LEGACY Investment
 * Intelligence pipeline (`lib/services/investment-intelligence/
 * documentProcessing.ts`), not through AIE — production holds ZERO rows in
 * `aie_document_intake`, `aie_extraction_run` and `aie_unresolved_item`
 * (read-only probe, 2026-09-16). PC5's resolution surface projects
 * `aie_unresolved_item` and nothing else, so it can resolve the AIE-pipeline
 * shape of this problem, which is what this script proves, and it has no
 * effect at all on a legacy `ii_reconciliation_cases` row of
 * `discrepancy_type = 'owner_unmatched'`. That gap is reported, not papered
 * over: see `docs/investment-intelligence/M12C_PC4_OWNER_MAPPING_OPERATOR_ACTION.md`.
 *
 * ANTI-VACUITY. Every "after" assertion has a matching "before" assertion
 * that had to hold FIRST. The script fails if the before-state was not
 * genuinely blocked, so a pass can never come from measuring nothing.
 *
 * SAFETY. DEV ONLY. The target url is asserted to be the DEV project and
 * asserted NOT to equal `PRODUCTION_SUPABASE_URL` before a single write. No
 * credential value is ever printed. Every row created is tracked and deleted
 * in a `finally` block, then INDEPENDENTLY re-queried to prove zero residue.
 * Every synthetic identifier is obviously fake (`zz-m12c-...@fhip-test.invalid`,
 * names prefixed `ZZ Synthetic`).
 *
 * Run: npx tsx scripts/m12c_pc5_owner_mapping_synthetic_repro.ts [baseUrl]
 * Requires a dev server started with AIE_REVIEW_PC5_PROJECTION_ENABLED=true.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const repoRoot = path.resolve(__dirname, '..');
const BASE = process.argv[2] ?? 'http://127.0.0.1:3958';

// The DEV project url is a NEXT_PUBLIC_ value (it appears in ~16 committed
// scripts) and is not a secret. It is named here because this worktree
// deliberately has no `.env.local` of its own and the shared file does not
// declare NEXT_PUBLIC_SUPABASE_URL.
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

// --- SAFETY GATE. Nothing below runs until this passes. --------------------
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

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): boolean {
  if (ok) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}${detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 1500)}` : ''}`);
  }
  return ok;
}

const stamp = Date.now();
const created = { users: [] as string[], households: [] as string[] };

/**
 * A real password sign-in through the real `/login` form.
 *
 * THE WAIT BEFORE THE CLICK IS LOAD-BEARING, not defensive padding. `next dev`
 * on the webpack builder compiles a route on first request, so a click fired
 * before React has hydrated submits the form NATIVELY — the browser navigates
 * back to `/login?` with the credentials in a query string and no sign-in
 * ever happens. That was observed on the first run of this script. Waiting
 * for the client bundle to settle makes the click a real React submit.
 */
async function signIn(page: import('playwright').Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(3000);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  try {
    await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 90_000 });
  } catch (e) {
    const onScreen = await page.locator('body').innerText().catch(() => '(unreadable)');
    throw new Error(`sign-in did not navigate. url=${page.url()} screen="${onScreen.slice(0, 400)}" cause=${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  console.log(`\n=== M12C §8.1 — PC5 owner-mapping synthetic reproduction — ${new URL(DEV_URL).host} — ${new Date().toISOString()} ===`);
  console.log(`app under test: ${BASE}\n`);

  const email = `zz-m12c-pc4-repro-${stamp}@fhip-test.invalid`;
  const password = `ZzM12c-${Math.random().toString(36).slice(2)}-Aa1!`;

  const createdUser = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (createdUser.error || !createdUser.data.user) throw new Error(`createUser failed: ${createdUser.error?.message}`);
  const userId = createdUser.data.user.id;
  created.users.push(userId);

  // `requireCountryConfirmedUser` gates every PC5 route, and
  // `resolveHouseholdCountryForUser` fails CLOSED. Both are satisfied here the
  // same way a real onboarded user satisfies them.
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
    .insert({ user_id: userId, household_name: `ZZ Synthetic M12C household ${stamp}`, primary_country: 'IN' })
    .select('id')
    .single();
  if (household.error) throw new Error(`household insert failed: ${household.error.message}`);
  const householdId = household.data.id as string;
  created.households.push(householdId);

  const member = async (fullName: string, relationship: string) => {
    const r = await admin
      .from('household_members')
      .insert({ user_id: userId, household_id: householdId, full_name: fullName, relationship, is_active: true })
      .select('id')
      .single();
    if (r.error) throw new Error(`household_members insert failed: ${r.error.message}`);
    return r.data.id as string;
  };
  const selfMemberId = await member('ZZ Synthetic Selfholder', 'self');
  const spouseMemberId = await member('ZZ Synthetic Spouseholder', 'spouse');

  // --- The document, the run, and the SAME unresolved shape production has --
  const intake = await admin
    .from('aie_document_intake')
    .insert({
      user_id: userId,
      declared_mime_type: 'application/pdf',
      byte_size: 2048,
      storage_key: `zz-m12c-repro/${userId}/${stamp}.bin`,
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

  // The adapter binding PC5's decide path dispatches on. Without it the
  // re-reconciliation returns `unsupported_adapter` and the proof would be
  // vacuous.
  const attempt = await admin.from('aie_parser_attempt').insert({
    run_id: runId,
    intake_id: intakeId,
    user_id: userId,
    adapter_id: II_ADAPTER_ID,
    outcome: 'complete',
    parser_version: 'm12c-repro-1',
  });
  if (attempt.error) throw new Error(`parser_attempt insert failed: ${attempt.error.message}`);

  // REAL candidates from the REAL certified CAMS parser, so the
  // re-reconciliation rehydrates genuine evidence rather than a hand-written
  // stub. The statement names no holder, which is exactly the production
  // shape: nobody said whose statement it was.
  const text = buildAieIiCasFixtureText();
  const detection = detectSource(text);
  if (!detection.parser) throw new Error('the synthetic CAS fixture was not claimed by any certified parser');
  const parsed = parseDocumentWithParser(detection.parser, text);
  const candidateRows = toAieCandidates(parsed).map((c) => ({
    run_id: runId,
    intake_id: intakeId,
    user_id: userId,
    field_name: c.fieldName,
    value_raw: c.valueRaw,
    is_null: c.isNull,
    source_method: c.sourceMethod,
    source_reference: c.sourceReference ?? null,
  }));
  const candidateInsert = await admin.from('aie_field_candidate').insert(candidateRows);
  if (candidateInsert.error) throw new Error(`field_candidate insert failed: ${candidateInsert.error.message}`);

  const item = await admin
    .from('aie_unresolved_item')
    .insert({
      run_id: runId,
      intake_id: intakeId,
      user_id: userId,
      reason_code: 'ii_adapter:owner_unresolved',
      severity: 'blocking',
      status: 'open',
      display_candidate: null,
      evidence_ref: { candidateMemberIds: [] },
      permitted_action_types: ['choose_value', 'reject_document', 'request_reprocessing', 'defer'],
    })
    .select('id, item_version')
    .single();
  if (item.error) throw new Error(`unresolved_item insert failed: ${item.error.message}`);
  const itemId = item.data.id as string;

  console.log(`seeded: user ${userId.slice(0, 8)} / run ${runId.slice(0, 8)} / item ${itemId.slice(0, 8)}\n`);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, email, password);
    check('a real authenticated browser session was established via /login', true);

    // =====================================================================
    // BEFORE — the state must genuinely be BLOCKED. If it is not, every
    // "after" assertion below is meaningless, so this is a hard gate.
    // =====================================================================
    const beforeApi = await page.evaluate(async () => {
      const res = await fetch('/api/pc5/resolutions');
      return { status: res.status, body: await res.json() };
    });
    const beforeItems: Array<Record<string, unknown>> = beforeApi.body?.data?.items ?? [];
    const beforeBlocking: number = beforeApi.body?.data?.stillBlockingCount ?? -1;
    const beforeTarget = beforeItems.find((i) => i.id === itemId);

    const beforeOk =
      check('BEFORE — GET /api/pc5/resolutions answers 200 over the real authenticated session', beforeApi.status === 200, beforeApi.body) &&
      check('BEFORE — the owner-unresolved item is present in the listing', Boolean(beforeTarget), { itemId, returned: beforeItems.map((i) => i.id) }) &&
      check('BEFORE — its reason code is ii_adapter:owner_unresolved', beforeTarget?.reasonCode === 'ii_adapter:owner_unresolved', beforeTarget?.reasonCode) &&
      check('BEFORE — its severity is blocking', beforeTarget?.severity === 'blocking', beforeTarget?.severity) &&
      check('BEFORE — its PC5 status is "open" (needs a decision)', beforeTarget?.status === 'open', beforeTarget?.status) &&
      check('BEFORE — the server-derived stillBlockingCount is non-zero', beforeBlocking >= 1, beforeBlocking);

    const beforeRun = await admin.from('aie_extraction_run').select('status').eq('id', runId).single();
    check('BEFORE — the extraction run is in status "unresolved" (cannot be accepted)', beforeRun.data?.status === 'unresolved', beforeRun.data?.status);

    // The screen itself, not just the API — the operator sees this.
    await page.goto(`${BASE}/investment-intelligence/resolutions`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2500);
    const blockingCopy = await page.getByText(/must be answered before the affected statements can be imported/i).count();
    check('BEFORE — the Resolutions screen states the statement cannot be imported yet', blockingCopy > 0, blockingCopy);
    const questionCopy = await page.getByText('We could not confirm who owns this investment account.').count();
    check('BEFORE — the screen shows the human question for this item', questionCopy > 0, questionCopy);

    if (!beforeOk) throw new Error('BEFORE state was not genuinely blocked — refusing to report an AFTER result');

    // =====================================================================
    // THE OPERATOR ACTION — every step below is a real click.
    // =====================================================================
    await page.getByRole('link', { name: 'Answer this' }).first().click();
    await page.waitForURL(/\/investment-intelligence\/resolutions\/[0-9a-f-]+/, { timeout: 30_000 });
    check('the "Answer this" link deep-links to the exact case (K.14)', page.url().includes(itemId), page.url().replace(BASE, ''));
    // The detail screen fetches its context client-side. Wait for the choice
    // field to actually RENDER before asserting on it — a fixed sleep was not
    // enough on the first run and produced four false failures against a
    // screen that was in fact correct.
    const selfRadio = page.locator(`input[type="radio"][name="pc5-choice"][value="${selfMemberId}"]`);
    await selfRadio.waitFor({ state: 'attached', timeout: 30_000 });

    const legend = await page.getByText('Who does this statement belong to?').count();
    check('the detail screen asks "Who does this statement belong to?"', legend > 0, legend);

    check('the correct household member is offered as a radio option', (await selfRadio.count()) > 0);
    const spouseRadio = page.locator(`input[type="radio"][name="pc5-choice"][value="${spouseMemberId}"]`);
    check('the other household member is offered too (a real choice, not one option)', (await spouseRadio.count()) > 0);
    const jointRadio = page.locator('input[type="radio"][name="pc5-choice"][value="joint"]');
    check('a "Jointly owned" option is offered when two or more owners exist (K.6)', (await jointRadio.count()) > 0);
    check(
      'the two member options are labelled with their real names',
      (await page.getByText('ZZ Synthetic Selfholder').count()) > 0 && (await page.getByText('ZZ Synthetic Spouseholder').count()) > 0,
    );

    const saveButton = page.getByRole('button', { name: 'Save this answer' });
    check('the save button is DISABLED before a choice is made', await saveButton.isDisabled());

    await selfRadio.check();
    check('the save button becomes ENABLED once an owner is chosen', await saveButton.isEnabled());

    const decideResponse = page.waitForResponse(
      (r) => r.url().includes(`/api/pc5/resolutions/${itemId}/decide`) && r.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await saveButton.click();
    const decideRes = await decideResponse;
    const decideBody = await decideRes.json().catch(() => null);
    check('POST /api/pc5/resolutions/{itemId}/decide answered 200 (the REAL HTTP route)', decideRes.status() === 200, {
      status: decideRes.status(),
      body: decideBody,
    });
    check('the response reports a re-reconciliation actually RAN', decideBody?.data?.reReconciliation?.ran === true, decideBody?.data?.reReconciliation);
    check(
      'the re-reconciliation reports zero blocking items remaining',
      decideBody?.data?.reReconciliation?.openBlockingItemCount === 0,
      decideBody?.data?.reReconciliation?.openBlockingItemCount,
    );

    await page.waitForTimeout(2500);
    const successCopy = await page.getByText(/Answer recorded and the statement re-checked/i).count();
    check('the screen confirms the answer was recorded and the statement re-checked', successCopy > 0, successCopy);

    // =====================================================================
    // AFTER — read the database directly, not the response we just asserted.
    // =====================================================================
    const afterItem = await admin.from('aie_unresolved_item').select('status, item_version').eq('id', itemId).single();
    check(
      'AFTER — the unresolved item is no longer live (resolved or superseded)',
      afterItem.data?.status === 'resolved' || afterItem.data?.status === 'superseded',
      afterItem.data?.status,
    );

    const afterRun = await admin.from('aie_extraction_run').select('status').eq('id', runId).single();
    check(
      'AFTER — the extraction run moved to "awaiting_acceptance" (the block cleared)',
      afterRun.data?.status === 'awaiting_acceptance',
      afterRun.data?.status,
    );

    const decision = await admin
      .from('aie_review_decision')
      .select('decision_type, correction_field_name, correction_value_normalized, resulting_reconciliation_at, actor_id')
      .eq('item_id', itemId)
      .eq('decision_type', 'pc5_choose_value')
      .maybeSingle();
    check('AFTER — an immutable pc5_choose_value decision exists in the audit trail', Boolean(decision.data), decision.error?.message);
    check('AFTER — the decision names the ownerMemberId field', decision.data?.correction_field_name === 'ownerMemberId', decision.data?.correction_field_name);
    check(
      'AFTER — the decision records the household member the operator chose',
      decision.data?.correction_value_normalized === selfMemberId,
      { recorded: String(decision.data?.correction_value_normalized).slice(0, 8), expected: selfMemberId.slice(0, 8) },
    );
    check('AFTER — the decision is stamped with when the re-reconciliation ran (K.19)', Boolean(decision.data?.resulting_reconciliation_at));
    check('AFTER — the decision is attributed to the operator, not to a system actor', decision.data?.actor_id === userId);

    // The listing the operator returns to must agree with all of the above.
    const afterApi = await page.evaluate(async () => {
      const res = await fetch('/api/pc5/resolutions');
      return { status: res.status, body: await res.json() };
    });
    check('AFTER — the Resolutions listing reports stillBlockingCount 0', afterApi.body?.data?.stillBlockingCount === 0, afterApi.body?.data?.stillBlockingCount);

    // ANTI-VACUITY: the before/after pair must actually differ.
    check('ANTI-VACUITY — the blocking count genuinely moved from non-zero to zero', beforeBlocking >= 1 && afterApi.body?.data?.stillBlockingCount === 0, {
      before: beforeBlocking,
      after: afterApi.body?.data?.stillBlockingCount,
    });

    // ---------------------------------------------------------------------
    // THE SCOPE BOUNDARY, MEASURED RATHER THAN ASSERTED. PC5 clears the AIE
    // block; the canonical `ii_source_documents.owner_member_id` write happens
    // LATER, at acceptance (`lib/aie/adapters/investment-intelligence/
    // write.ts` `insertSourceDocument`, which passes `params.ownerMemberId`).
    // This run does not drive acceptance, so the value is expected to be
    // absent here — and that expectation is CHECKED, so the report can state
    // the boundary as an observation rather than an assumption.
    // ---------------------------------------------------------------------
    const link = await admin.from('aie_ii_adapter_link').select('ii_source_document_id').eq('aie_run_id', runId).maybeSingle();
    check(
      'BOUNDARY (expected) — no canonical ii_source_documents row exists yet: PC5 unblocks, acceptance writes',
      !link.data,
      link.data ?? null,
    );
  } finally {
    await browser.close();

    // ------------------------------------------------------------------
    // Cleanup, children first, then independent zero-residue re-query.
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
    check('ZERO RESIDUE — every synthetic row independently re-queried and absent', total === 0, { residue, usersRemaining });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

void main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
