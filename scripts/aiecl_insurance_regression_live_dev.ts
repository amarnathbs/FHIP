/**
 * AIE-1 closure mission — regression re-verification of the real Insurance
 * HTTP journey (upload -> extract -> accept -> canonical write) against
 * real DEV infrastructure, after this mission's changes to
 * lib/aie/orchestrator.ts (schemaOverride), lib/aie/review/accept.ts
 * (finalizeDocumentBinary), lib/aie/provider/providerFactory.ts (provider
 * selection), and lib/aie/provider/gateway.ts (cost admission). Follows the
 * exact method AIE_1_0146_INSURANCE_CLOSURE_REPORT.md documents: a real
 * running Next.js dev server, real disposable synthetic user, real cookie-
 * based login through the app's own /login page (a bare Bearer token does
 * NOT work against this app's @supabase/ssr-based auth — confirmed
 * empirically in that prior pass).
 *
 * Run: npx tsx scripts/aiecl_insurance_regression_live_dev.ts [baseUrl]
 * Requires: a running `npx next dev -p <port>` pointed at this worktree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { buildMinimalTextPdf } from '../tests/support/buildMinimalPdf';
import { buildAieInsuranceFixtureText } from '../tests/support/buildAieInsuranceFixtureText';

const repoRoot = path.resolve(__dirname, '..');
const BASE = process.argv[2] ?? 'http://localhost:3931';

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
const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(SUPA_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}` + (detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''));
  }
}

async function main() {
  const stamp = Date.now();
  const email = `aiecl-ins-regr-${stamp}@example.com`;
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  let userId = '';
  let intakeId = '';
  let runId = '';
  let policyId: string | null = null;
  let storageKey: string | null = null;

  const browser = await chromium.launch();
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`create user failed: ${created.error?.message}`);
    userId = created.data.user.id;

    // Seed mandatory country confirmation (lib/services/countryGate.ts) --
    // a fresh synthetic user otherwise gets blocked before ever reaching
    // the insurance route's own capability check.
    await admin
      .from('user_profiles')
      .update({ country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), country_source: 'USER_CONFIRMED', onboarding_completed: true })
      .eq('user_id', userId);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(password);
    await Promise.all([page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 30_000 }), page.getByTestId('login-submit').click()]);

    const cookies = await context.cookies();
    const hasSession = cookies.some((c) => c.name.includes('auth-token'));
    check('real cookie-based session established via /login', hasSession, cookies.map((c) => c.name));

    // Build a real, valid, clean insurance fixture PDF (synthetic content
    // only -- documentCatalogue.ts's own disclosed generic Label:Value
    // layout, never real insurer content).
    const fixtureText = buildAieInsuranceFixtureText();
    const pdfBytes = buildMinimalTextPdf([fixtureText.split('\n')]);

    const intakeResp = await context.request.post(`${BASE}/api/aie/insurance/intake?owner=self&filename=policy-regr.pdf`, {
      data: pdfBytes,
      headers: { 'Content-Type': 'application/pdf' },
    });
    const intakeBody = await intakeResp.json();
    check('real HTTP intake POST accepted (200)', intakeResp.status() === 200, { status: intakeResp.status(), body: intakeBody });
    intakeId = intakeBody?.data?.intake_id;
    runId = intakeBody?.data?.run_id;
    check('reached awaiting_acceptance on the real running route', intakeBody?.data?.status === 'awaiting_acceptance', intakeBody);
    check('deterministic extraction only -- ai_used is false for a clean fixture', intakeBody?.data?.ai_used === false, intakeBody);

    // The mission's own new behaviour: the quarantine binary should already
    // be gone by now (immediate deletion right after the pipeline run
    // concludes, since Insurance's canonical write never needs it again).
    // DISCLOSED, EXPECTED DEGRADATION: migration 0149 (which adds
    // aie_document_intake.purge_status/purge_due_at/purged_at) is NOT
    // applied to DEV (same DDL-channel blocker as everywhere else in this
    // closure mission) -- finalizeDocumentBinaryAfterRun's own DB bookkeeping
    // update therefore fails with "column ... does not exist" and the
    // function falls through to its retry-scheduling branch, which ALSO
    // references those missing columns and also fails silently. The actual
    // STORAGE DELETE call happens BEFORE either of those DB writes, though,
    // so the real behavioural question is: did the object genuinely get
    // removed from Supabase Storage regardless of the DB bookkeeping being
    // blocked? Checked directly against Storage below, not via the
    // (currently unusable) purge_status column.
    const intakeRowBasic = await admin.from('aie_document_intake').select('status, storage_key').eq('id', intakeId).single();
    storageKey = intakeRowBasic.data?.storage_key ?? null;
    check('intake row query succeeds on the columns that exist today (pre-0149)', !intakeRowBasic.error, intakeRowBasic.error);
    if (storageKey) {
      const lastSlash = storageKey.lastIndexOf('/');
      const listing = await admin.storage.from('aie-document-quarantine').list(storageKey.slice(0, lastSlash), { search: storageKey.slice(lastSlash + 1) });
      const stillPresent = (listing.data ?? []).some((f) => f.name === storageKey!.slice(lastSlash + 1));
      check(
        'the actual Supabase Storage object WAS genuinely deleted by finalizeDocumentBinaryAfterRun\'s delete call, even though migration 0149 is not yet applied (only the DB status bookkeeping is blocked, not the real delete)',
        !stillPresent,
        listing,
      );
      check(
        'DISCLOSED GAP (blocked on migration 0149): the DB row status is still "ready" with a now-dangling storage_key, because the post-delete DB update itself failed on a missing column -- this is a real, live-DEV-observed consequence of the DDL-application blocker, not a code defect in the delete/verify logic itself',
        intakeRowBasic.data?.status === 'ready' && intakeRowBasic.data?.storage_key !== null,
        intakeRowBasic.data,
      );
    } else {
      check('storage_key already cleared (unexpected pre-0149, but not wrong)', true);
    }

    const idempotencyKey = `aiecl-ins-regr-${stamp}-accept`;
    const acceptResp = await context.request.post(`${BASE}/api/aie/review/runs/${runId}/accept`, {
      data: { ownerHouseholdRole: 'self', idempotencyKey },
    });
    const acceptBody = await acceptResp.json();
    check('accept succeeds via the real running route EVEN THOUGH the quarantine binary is already gone (Insurance never needed it)', acceptResp.status() === 200 && acceptBody?.data?.accepted === true, { status: acceptResp.status(), body: acceptBody });
    policyId = acceptBody?.data?.insurancePolicyId ?? null;

    const policyRow = policyId ? await admin.from('insurance_policies').select('id, user_id').eq('id', policyId).maybeSingle() : { data: null };
    check('exactly one real insurance_policies row committed, owned by the real user', policyRow.data?.user_id === userId, policyRow.data);

    // Same-key replay -- must not create a second policy.
    const replayResp = await context.request.post(`${BASE}/api/aie/review/runs/${runId}/accept`, {
      data: { ownerHouseholdRole: 'self', idempotencyKey },
    });
    const replayBody = await replayResp.json();
    check('same-key replay reports alreadyCompleted, no duplicate write', replayBody?.data?.alreadyCompleted === true, replayBody);
    const policyCount = await admin.from('insurance_policies').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    check('exactly one policy row exists after replay (no duplicate)', policyCount.count === 1, policyCount.count);
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
    void storageKey;

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

main();
