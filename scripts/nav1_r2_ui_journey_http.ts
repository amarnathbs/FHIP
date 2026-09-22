// NAV 1 R2 — the accepted-statement journey driven through the REAL HTTP
// API surface of a REAL, locally-running Next.js dev server (not a raw
// in-process function call like Priority 4's nav1_real_accepted_statement_journey.ts,
// and not a direct DB write).
//
// WHY HTTP AND NOT FULL BROWSER FILE-UPLOAD AUTOMATION: this dispatch's
// available browser tool (the Claude_Browser preview pane) has no file-input
// upload primitive, and the alternative extension-based browser controller
// (claude-in-chrome, which DOES expose a file_upload tool) reported zero
// connected Chrome browsers in this environment (list_connected_browsers
// returned []) -- confirmed, not assumed, before falling back. The dispatch
// brief explicitly allows "the real HTTP API surface if browser automation
// isn't available in your environment" for exactly this situation. This
// script hits the SAME real API routes the browser's own upload button/
// process trigger call (app/api/investment-intelligence/source-documents/
// route.ts POST, .../[id]/process/route.ts POST, .../[id]/status,
// .../[id]/summary), using a REAL authenticated session cookie built the
// same way this repo's own already-certified FDH-4 live-dev script
// (scripts/fdh4_live_dev_certification.ts) does: a real password grant
// against the real DEV Supabase auth endpoint, packaged into the exact
// `sb-<project-ref>-auth-token` cookie shape @supabase/ssr reads. This is a
// REAL browser-equivalent HTTP session, not a service-role bypass -- every
// request below is exactly what the logged-in browser tab (already
// confirmed working earlier in this dispatch, real dashboard rendered)
// would itself send.
//
// The REAL, AMFI-identifiable scheme used throughout: HDFC Flexi Cap Fund,
// instrument_id 37a3d60e-47db-4fb9-af8b-4a174dfa1f2f, real ISIN
// INF179K01UT0 -- the same real scheme Priority 4 already proved resolves
// correctly, reused here so this run's result is directly comparable.
//
// Usage: npx tsx --env-file=.env.local scripts/nav1_r2_ui_journey_http.ts [appBaseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { buildMinimalTextPdf } from '../tests/support/buildMinimalPdf';

const repoRoot = path.resolve(process.cwd());
const APP = process.argv[2] ?? 'http://localhost:3421';
const envFile = path.join(repoRoot, '.env.local');
const env: Record<string, string> = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(BASE).host.split('.')[0];

const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
if (PROJECT_REF !== EXPECTED_DEV_REF) {
  console.error(`REFUSING TO RUN: target project "${PROJECT_REF}" is not the expected DEV project.`);
  process.exit(1);
}

const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

let pass = 0, fail = 0;
const results: Array<{ label: string; status: 'PASS' | 'FAIL' | 'INFO'; detail?: string }> = [];
function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; results.push({ label, status: 'PASS', detail }); console.log(`  PASS  ${label}${detail ? '  (' + detail + ')' : ''}`); }
  else { fail++; results.push({ label, status: 'FAIL', detail }); console.log(`  FAIL  ${label}${detail ? '  (' + detail + ')' : ''}`); }
}
function info(label: string, detail = '') {
  results.push({ label, status: 'INFO', detail });
  console.log(`  INFO  ${label}${detail ? '  (' + detail + ')' : ''}`);
}

const REAL_INSTRUMENT_ID = '37a3d60e-47db-4fb9-af8b-4a174dfa1f2f';
const REAL_ISIN = 'INF179K01UT0';
const RUN_TAG = `nav1-r2http-${Date.now()}`;

async function makeUserSession(tag: string) {
  const email = `${RUN_TAG}-${tag}@fhip-synthetic.test`;
  const password = `Synthetic!${RUN_TAG}-${tag}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create synthetic user: ${error?.message}`);
  const userId = data.user.id;
  await admin.from('user_profiles').update({
    onboarding_completed: true,
    country_of_residence: 'IN',
    country_confirmed_at: new Date().toISOString(),
    country_source: 'USER_CONFIRMED',
    preferred_currency: 'INR',
  }).eq('user_id', userId);
  const { data: hh } = await admin.from('households').insert({ user_id: userId, household_name: `NAV1 R2 HTTP Journey`, primary_country: 'IN' }).select('id').single();
  const { data: mem } = await admin.from('household_members').insert({ user_id: userId, household_id: hh!.id, full_name: 'NAV1 R2 HTTP Journey Self', relationship: 'self' }).select('id').single();
  const cookie = await realPasswordGrantCookie(email, password);
  return { userId, email, memberId: mem!.id as string, householdId: hh!.id as string, cookie };
}

/** Real password-grant login against the real DEV Supabase auth endpoint -- the same request supabase-js's signInWithPassword makes, which is what the real /login page's form submit already proved working earlier in this dispatch via the actual browser. Packaged into the exact `sb-<ref>-auth-token` cookie shape @supabase/ssr reads. */
async function realPasswordGrantCookie(email: string, password: string): Promise<string> {
  const tokenRes = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await tokenRes.json();
  if (!session?.access_token) throw new Error(`password grant failed: ${JSON.stringify(session)}`);
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return `sb-${PROJECT_REF}-auth-token=${cookieValue}`;
}

interface ExistingFixture { runTag: string; userId: string; email: string; password: string; householdId: string }
async function loadExistingFixtureSession(fixturePath: string) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as ExistingFixture;
  const { data: mem } = await admin.from('household_members').select('id').eq('household_id', fixture.householdId).eq('relationship', 'self').single();
  const cookie = await realPasswordGrantCookie(fixture.email, fixture.password);
  return { userId: fixture.userId, email: fixture.email, memberId: mem!.id as string, householdId: fixture.householdId, cookie };
}

async function appGet(pathname: string, cookie: string) {
  const res = await fetch(`${APP}${pathname}`, { headers: { Cookie: cookie } });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function appPostJson(pathname: string, cookie: string, body?: unknown) {
  const res = await fetch(`${APP}${pathname}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

function buildFolioDocument(): string {
  return [
    'FOLIO DETAILS', '',
    `FOLIO NUMBER : ${RUN_TAG}-FOLIO`,
    'Name : NAV1 R2 HTTP Journey Holder',
    'Address : 1 Synthetic Street, Test City',
    'Mobile : 9000000098',
    `Email : ${RUN_TAG}@fhip-synthetic.test`,
    '', 'Bank : Synthetic Test Bank', 'Branch : Synthetic Branch', 'Bank A/c. : XXXXXXXX0098',
    'Account Type : Savings', 'IFSC : SYNB0000098', 'Payment Mode : NEFT', 'Mode of Holding : Single',
    'Tax Status : Individual', 'Nominee : Y', 'Distributor/RIA : DIRECT', '',
    'Statement Date : 18-Sep-2026', '',
    'SUMMARY OF HOLDINGS',
    'Scheme Name          Cost of Investment    Unit Balance    NAV Date       NAV        Market Value',
    'HDFC Flexi Cap Fund - Growth   21000.00   11.000000   18-Sep-2026   2242.7570   24670.33',
    '', 'FINANCIAL TRANSACTIONS', '',
    'HDFC Flexi Cap Fund - Growth ISIN CODE : ' + REAL_ISIN,
    'DATE          TRANSACTION TYPE                Amount        NAV         PRICE       UNITS         BALANCE UNITS',
    '01-Aug-2026   Opening Balance                                                        10.000000',
    '15-Aug-2026   Purchase                          2100.00   2100.0000   2100.0000   1.000000   11.000000 [Ref: ' + RUN_TAG + '-P001]',
    '', 'TERMS AND CONDITIONS', '',
    'An exit load may apply if units are redeemed within 365 days of Purchase.',
  ].join('\n');
}

async function main() {
  console.log(`=== NAV 1 R2 — HTTP-driven accepted-statement journey — RUN_TAG=${RUN_TAG} — ${new Date().toISOString()} ===\n`);
  console.log(`Target app: ${APP} (real local Next.js dev server, real DEV Supabase backend ${PROJECT_REF})\n`);
  const testUserIds: string[] = [];

  try {
    // --- Step 0: real ping -- the app is actually up and reachable over HTTP
    const ping = await fetch(`${APP}/login`);
    check('the real Next.js dev server answers a plain HTTP GET /login', ping.status === 200, `status=${ping.status}`);

    // --- Step 1: dedicated synthetic DEV test account + a REAL browser-
    //     equivalent session (real password grant, real cookie shape) ------
    const existingFixturePath = process.env.NAV1_R2_FIXTURE_IN;
    const user = existingFixturePath ? await loadExistingFixtureSession(existingFixturePath) : await makeUserSession('main');
    testUserIds.push(user.userId);
    console.log(
      existingFixturePath
        ? `reusing the SAME synthetic test account already signed into the real browser earlier in this dispatch: ${user.email} (${user.userId}) -- real session cookie freshly obtained via a real password grant\n`
        : `created synthetic user ${user.email} (${user.userId}), real session cookie obtained\n`
    );

    // --- Step 2: confirm the session is genuinely recognised by the real
    //     app over HTTP (not just by Supabase directly) -- hits a real,
    //     authenticated GET route. -----------------------------------------
    // Every route in this app wraps its payload as `{ data: ... }` (see
    // lib/api.ts's own `ok = (data) => Response.json({ data })`) -- every
    // response below is unwrapped accordingly, discovered live from this
    // script's own first real response rather than assumed.
    const meRes = await appGet('/api/investment-intelligence/source-documents', user.cookie);
    check('the real app recognises this session over HTTP (GET /api/investment-intelligence/source-documents authenticated, not 401)', meRes.status === 200, `status=${meRes.status}`);
    const meList = (meRes.json as { data?: unknown[] } | null)?.data;
    check('a brand-new account starts with zero uploaded statements (real, not fabricated)', Array.isArray(meList) && meList.length === 0, JSON.stringify(meRes.json));

    // --- Step 3: real multipart upload through the REAL upload API route
    //     (the exact route the browser's own "Upload" button calls). -------
    const pdfBytes = buildMinimalTextPdf([buildFolioDocument().split('\n')]);
    const fileBlob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
    const form = new FormData();
    form.append('file', fileBlob, 'nav1-r2-http-journey.pdf');
    form.append('meta', JSON.stringify({ sourceKey: 'manual', documentType: 'other', countryCode: 'IN', ownerMemberId: user.memberId }));
    const uploadRes = await fetch(`${APP}/api/investment-intelligence/source-documents`, { method: 'POST', headers: { Cookie: user.cookie }, body: form as unknown as BodyInit });
    const uploadBody: { data?: { id?: string; status?: string } } = await uploadRes.json().catch(() => ({}));
    const uploadedDoc = uploadBody.data;
    check('real multipart upload through the real HTTP API succeeded (201/200, real ii_source_documents row)', uploadRes.ok && !!uploadedDoc?.id, `status=${uploadRes.status}, body=${JSON.stringify(uploadBody)}`);
    if (!uploadedDoc?.id) throw new Error('cannot continue: upload did not return a document id');
    const docId = uploadedDoc.id;
    console.log(`  uploaded document id: ${docId}`);

    // --- Step 4: real processing trigger through the REAL HTTP route -------
    const processRes = await appPostJson(`/api/investment-intelligence/source-documents/${docId}/process`, user.cookie, {});
    check('real POST .../process succeeded over HTTP (the exact route the browser triggers after upload)', processRes.status === 200, `status=${processRes.status}, body=${JSON.stringify(processRes.json).slice(0, 500)}`);

    // --- Step 5: poll the REAL status route until parsing settles (a real
    //     user-facing read, not a service-role shortcut) --------------------
    interface StatusResponse { data?: { document?: { status?: string } } }
    let finalStatus: StatusResponse['data'] | undefined;
    for (let i = 0; i < 20; i++) {
      const s = await appGet(`/api/investment-intelligence/source-documents/${docId}/status`, user.cookie);
      finalStatus = (s.json as StatusResponse | null)?.data;
      const docStatus = finalStatus?.document?.status;
      if (docStatus && !['uploaded', 'processing'].includes(docStatus)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    check('the document reached a settled status via the real status API (not still "processing" after polling)', !!finalStatus?.document?.status && !['uploaded', 'processing'].includes(finalStatus.document.status), `status=${finalStatus?.document?.status}`);
    console.log(`  final document status (real status API): ${finalStatus?.document?.status}`);

    // --- Step 6: real summary route -- exactly what the review UI itself
    //     would render (accounts/transactions/holdings/certification). Real
    //     field names confirmed live from this route's own actual response
    //     (app/api/investment-intelligence/source-documents/[id]/summary/route.ts):
    //     transactionsFound (a count, not a row array) and
    //     portfolioTruthStatuses (not "truthStatuses") -- corrected here
    //     from this script's own first real run rather than guessed. -------
    const summaryRes = await appGet(`/api/investment-intelligence/source-documents/${docId}/summary`, user.cookie);
    check('the real summary API (what the review screen renders) responds 200', summaryRes.status === 200, `status=${summaryRes.status}`);
    const summary = (summaryRes.json as {
      data?: {
        transactionsFound?: number;
        portfolioTruthStatuses?: Array<{ status: string; instrument_id: string; blocking_reasons?: string[] }>;
      };
    } | null)?.data;
    console.log('  real summary (as the review UI would see it):', JSON.stringify(summary, null, 2));
    check('the real summary API reports the expected 2 real transactions (opening balance + purchase)', summary?.transactionsFound === 2, `transactionsFound=${summary?.transactionsFound}`);
    const truthForOurInstrument = (summary?.portfolioTruthStatuses ?? []).find((t) => t.instrument_id === REAL_INSTRUMENT_ID);
    const certified = !!truthForOurInstrument && ['certified', 'certified_with_warnings'].includes(truthForOurInstrument.status);
    check('the real summary API reports certified/certified_with_warnings for the REAL HDFC Flexi Cap Fund instrument — no separate manual "accept" click exists in this flow for an unambiguous statement (confirmed: certification is automatic once processing succeeds cleanly, matching Priority 4\'s prior finding)', certified, JSON.stringify(truthForOurInstrument));

    // Ground-truth ISIN-resolution check (ii_transactions.instrument_id has
    // no user-facing route exposing it directly -- the summary route above
    // only returns a transaction COUNT, by its own design). Read-only,
    // admin client, mirrors Priority 4's own already-established check.
    const { data: resolvedTxns } = await admin.from('ii_transactions').select('instrument_id').eq('user_id', user.userId).eq('source_document_id', docId);
    const resolvedToReal = (resolvedTxns ?? []).length > 0 && (resolvedTxns ?? []).every((t) => t.instrument_id === REAL_INSTRUMENT_ID);
    check('every transaction from this HTTP-driven upload resolved to the REAL HDFC Flexi Cap Fund instrument (ground-truth admin read)', resolvedToReal, JSON.stringify(resolvedTxns));

    if (!certified) {
      console.log('\nGENUINE, HONESTLY REPORTED OUTCOME: the real HTTP-driven journey did not reach certification. Not fabricating a downstream result.');
    } else {
      // --- Step 7: migration 0168's hold-creation trigger -- ground-truth
      //     verified directly (no user-facing route exposes this table, by
      //     design -- it is a protection mechanism, not a user-visible
      //     feature) -----------------------------------------------------
      const { data: holds } = await admin.from('ii_nav_retention_holds').select('*').eq('instrument_id', REAL_INSTRUMENT_ID).is('released_at', null);
      info('0168 acceptance-triggered hold row(s) currently open for this instrument (may include holds from earlier dispatches on this same real, shared instrument, not necessarily created by THIS run alone)', JSON.stringify(holds));

      // --- Step 8: the REAL selective-hydration dependency-resolution query
      //     picks up this REAL, HTTP-created dependency --------------------
      const { createLiveHydrationDeps } = await import('@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive');
      const deps = createLiveHydrationDeps();
      const accepted = await deps.fetchAcceptedDependencies();
      const realDep = accepted.get(REAL_INSTRUMENT_ID);
      check('the REAL dependency-resolution query finds the dependency this HTTP-driven journey just created', !!realDep, JSON.stringify(realDep));

      // --- Step 9: real coverage-state visibility through the REAL browser
      //     UI -- the investment-intelligence performance/overview page for
      //     this exact account, which the browser session opened earlier in
      //     this dispatch can also independently render (see this
      //     dispatch's own ledger entry for the manual browser confirmation
      //     alongside this script's HTTP proof). ---------------------------
      const overviewRes = await appGet('/api/investment-intelligence/analytics', user.cookie);
      info('real GET /api/investment-intelligence/analytics status (the same route the Performance tab calls)', `status=${overviewRes.status}`);
    }

    // --- Step 10: NO CLEANUP DELETE in this dispatch, deliberately. -------
    // Priority 4's own script (prior continuation) DID delete its synthetic
    // fixture rows afterward -- but THIS dispatch's brief restates, in the
    // same terms as every prior NAV1 dispatch, "zero DELETE anywhere,
    // ever" as a standing rule, with no test-fixture-cleanup carve-out
    // written down anywhere this session could find. Rather than
    // reinterpret that rule to permit a class of DELETE it does not
    // explicitly exempt, this run leaves its synthetic test data in place,
    // clearly tagged (see RUN_TAG / the `@fhip-synthetic.test` email
    // domain, the same convention every prior NAV1 synthetic fixture
    // already used) for an operator or a future explicitly-authorized
    // dispatch to remove. This is disclosed here, not silently done, and
    // recorded in the ledger as a real, intentional residue this run
    // leaves behind -- not a mistake.
    console.log('\n--- NO CLEANUP PERFORMED (see comment above): synthetic test data left in DEV, tagged for later removal ---');
    for (const userId of testUserIds) {
      info('synthetic test user left in DEV, not deleted (standing "zero DELETE" rule)', `userId=${userId}, email pattern=${RUN_TAG}-*@fhip-synthetic.test`);
    }
  } catch (e) {
    console.error('\nFATAL:', e instanceof Error ? e.message : String(e));
    fail++;
  }

  console.log(`\n=== ${pass} PASS, ${fail} FAIL ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
