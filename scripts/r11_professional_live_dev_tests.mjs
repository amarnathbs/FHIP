// Investment Intelligence R11 -- TERMINAL CLOSURE -- the missing
// professional-access LIVE DEV certification (spec sections 7-26,
// LIVE-R11-P01..P12). Real DEV Supabase, real authenticated synthetic
// users (real signup + real password sign-in, real session cookies), the
// REAL running Next.js app over HTTP (not internal helper functions called
// directly -- spec section 8's explicit requirement), real RLS, real
// relationship/consent/scope rows, a real R10 report.
//
// Run:  node scripts/r11_professional_live_dev_tests.mjs [appBaseUrl]
// Requires a real `next dev --webpack` (or `next start`) instance already
// running at appBaseUrl (default http://localhost:3199) and .env.local.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3199';

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(BASE).host.split('.')[0];

const results = [];
function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 700)}`);
}

async function sb(p, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

const stamp = Date.now();
const cleanup = { users: [] };

async function makeUser(tag) {
  const email = `r11-prof-${tag}-${stamp}@fhip-test.invalid`;
  const password = `TestPass!${stamp}Aa1`;
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = await res2.json();
  if (!id || !session?.access_token) throw new Error(`user setup failed for ${tag}: ${created.text} ${JSON.stringify(session)}`);
  cleanup.users.push({ id, tag });
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, email, session, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

async function app(pathname, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(`${APP}${pathname}`, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function asUserRest(p, { accessToken, method = 'GET', body } = {}) {
  const headers = { apikey: ANON, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function makeClientWithData(tag) {
  const u = await makeUser(tag);
  const hh = await sb('/rest/v1/households', { method: 'POST', prefer: 'return=representation', body: { user_id: u.id, household_name: `R11 prof client ${tag}`, primary_country: 'IN' } });
  const hhId = hh.json?.[0]?.id;
  const mem = await sb('/rest/v1/household_members', { method: 'POST', prefer: 'return=representation', body: { user_id: u.id, household_id: hhId, full_name: `R11 Prof Client ${tag}`, relationship: 'self' } });
  const memId = mem.json?.[0]?.id;
  // Real II holdings for this client (structured data the investments-summary proxy reads).
  const acc = await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: u.id, account_type: 'mf_folio', institution_name: 'HDFC Mutual Fund', country_code: 'IN', currency_code: 'INR', folio_number: `PROF-${tag}-${stamp}`, status: 'active', owner_member_id: memId } });
  const accId = acc.json?.[0]?.id;
  const instr = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: `R11 Prof Test Fund ${tag}`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional', amc_name: 'HDFC Mutual Fund' } });
  const instrId = instr.json?.[0]?.id;
  await sb('/rest/v1/ii_holding_snapshots', { method: 'POST', body: { user_id: u.id, account_id: accId, instrument_id: instrId, as_of_date: '2026-06-30', units: 100, value: 15000, currency_code: 'INR', quality_status: 'certified' } });
  // Real R10 report -- premium entitlement + minimal financials + generate through the real app route.
  await sb(`/rest/v1/user_entitlements?user_id=eq.${u.id}`, { method: 'PATCH', body: { plan_tier: 'premium' } });
  await sb('/rest/v1/income_sources', { method: 'POST', body: { user_id: u.id, source_name: 'Salary', amount: 8000, frequency: 'monthly', is_active: true } });
  await sb('/rest/v1/expense_items', { method: 'POST', body: { user_id: u.id, expense_name: 'Rent', amount: 2000, frequency: 'monthly', is_essential: true, expense_category: 'housing', is_active: true } });
  await sb('/rest/v1/assets', { method: 'POST', body: { user_id: u.id, asset_name: 'Savings', current_value: 50000, asset_class: 'cash', country_code: 'IN', is_active: true } });
  const genRes = await app('/api/reports/generate', { cookie: u.cookie, method: 'POST', body: { reportType: 'net_worth' } });
  const reportId = (genRes.json?.data ?? genRes.json)?.report?.id;
  if (!reportId) throw new Error(`report generation failed for client ${tag}: ${genRes.status} ${genRes.text.slice(0, 300)}`);
  // Real raw source document + storage object, owned by this client -- for
  // the raw-document-privacy test (P06).
  const objectKey = `${u.id}/${crypto.randomUUID()}.pdf`;
  const pdfBytes = Buffer.from('%PDF-1.4\n%%EOF\n');
  const upload = await fetch(`${BASE}/storage/v1/object/${objectKey.split('/').map(encodeURIComponent).join('/')}`.replace('/object/', '/object/investment-source-documents/'), {
    method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/pdf' }, body: pdfBytes,
  });
  const docRow = await sb('/rest/v1/ii_source_documents', { method: 'POST', prefer: 'return=representation', body: { user_id: u.id, owner_member_id: memId, country_code: 'IN', status: 'uploaded', checksum: `sha-${stamp}-${tag}`, storage_path: objectKey, original_filename: 'raw.pdf', mime_type: 'application/pdf', file_size: pdfBytes.length, document_type: 'cas_statement' } });
  return { ...u, householdId: hhId, memberId: memId, accountId: accId, instrumentId: instrId, reportId, objectKey, uploadOk: upload.ok, uploadStatus: upload.status, docId: docRow.json?.[0]?.id };
}

async function makeProfessional(tag) {
  const u = await makeUser(tag);
  const prof = await sb('/rest/v1/professional_profiles', { method: 'POST', prefer: 'return=representation', body: { user_id: u.id, display_name: `R11 Prof ${tag}`, organisation: 'Test Advisory', professional_type: 'financial_adviser', contact_email: u.email, is_active: true } });
  if (!prof.json?.[0]?.id) throw new Error(`professional profile seed failed for ${tag}: ${prof.text}`);
  return { ...u, profileId: prof.json[0].id };
}

async function main() {
  console.log(`=== R11 PROFESSIONAL LIVE DEV certification run, stamp=${stamp} ===`);
  console.log(`Target app: ${APP}`);
  console.log(`Target DEV Supabase: ${BASE}\n`);

  const clientA = await makeClientWithData('A');
  const clientB = await makeClientWithData('B');
  const p1 = await makeProfessional('P1');
  const p2 = await makeProfessional('P2');
  record('SETUP', 'Client A/B + Professional P1/P2 real users, holdings, R10 reports, raw storage objects seeded', clientA.uploadOk && clientB.uploadOk ? 'PASS' : 'FAIL', `clientA.reportId=${clientA.reportId} clientB.reportId=${clientB.reportId} uploadA=${clientA.uploadStatus} uploadB=${clientB.uploadStatus}`);

  // -------------------------------------------------------------------
  // LIVE-R11-P01: Invitation
  // -------------------------------------------------------------------
  let relId;
  {
    const res = await app('/api/professional-access/invitations', { cookie: clientA.cookie, method: 'POST', body: { professionalUserId: p1.id, purpose: 'R11 live test engagement', scopes: ['VIEW_INVESTMENTS'] } });
    relId = res.json?.data?.relationshipId;
    const relRow = await sb(`/rest/v1/professional_relationships?id=eq.${relId}`);
    const rel = relRow.json?.[0];
    const auditRow = await sb(`/rest/v1/professional_consent_audit?relationship_id=eq.${relId}&event_type=eq.invited`);
    const ok = res.status === 200 && !!relId && rel?.status === 'pending_invite' && rel?.client_user_id === clientA.id && rel?.professional_user_id === p1.id && rel?.invited_by === 'client' && (auditRow.json?.length ?? 0) >= 1;
    record('LIVE-R11-P01', 'Invitation: client A invites P1 with bounded scope VIEW_INVESTMENTS -- relationship + consent audit created correctly', ok ? 'PASS' : 'FAIL', `status=${res.status} rel=${JSON.stringify(rel)} auditRows=${auditRow.json?.length}`);
  }

  // -------------------------------------------------------------------
  // LIVE-R11-P02: Acceptance -- only via the authorised workflow
  // -------------------------------------------------------------------
  {
    // Negative half first: P1 must not be able to activate directly via raw PostgREST.
    const forgeActivate = await asUserRest(`/rest/v1/professional_relationships?id=eq.${relId}`, { accessToken: p1.session.access_token, method: 'PATCH', body: { status: 'active' } });
    const stillPending = (await sb(`/rest/v1/professional_relationships?id=eq.${relId}`)).json?.[0]?.status === 'pending_invite';
    // Positive half: P1 accepts through the real app route.
    const res = await app(`/api/professional-access/invitations/${relId}/accept`, { cookie: p1.cookie, method: 'POST' });
    const relRow = await sb(`/rest/v1/professional_relationships?id=eq.${relId}`);
    const rel = relRow.json?.[0];
    const ok = stillPending && res.status === 200 && rel?.status === 'active' && !!rel?.accepted_at;
    record('LIVE-R11-P02', 'Acceptance: PENDING->ACTIVE only through the authorised accept workflow; P1 cannot self-activate directly', ok ? 'PASS' : 'FAIL', `forgeActivate.status=${forgeActivate.status} stillPendingBeforeAccept=${stillPending} acceptRes.status=${res.status} rel=${JSON.stringify(rel)}`);
  }

  // -------------------------------------------------------------------
  // LIVE-R11-P04 (run before P05 grants VIEW_REPORTS): Out-of-scope module
  // -------------------------------------------------------------------
  {
    const res = await app(`/api/professional-access/proxy/report?clientUserId=${clientA.id}&reportId=${clientA.reportId}`, { cookie: p1.cookie });
    const ok = res.status === 403;
    record('LIVE-R11-P04', 'Out-of-scope module: P1 has VIEW_INVESTMENTS but not VIEW_REPORTS -- report access DENIED', ok ? 'PASS' : 'FAIL', `status=${res.status} body=${res.text.slice(0, 200)}`);
  }

  // -------------------------------------------------------------------
  // LIVE-R11-P03: Authorised investment view
  // -------------------------------------------------------------------
  {
    const res = await app(`/api/professional-access/proxy/investments-summary?clientUserId=${clientA.id}`, { cookie: p1.cookie });
    const data = res.json?.data ?? res.json;
    const positions = data?.positions ?? [];
    const belongsOnlyToA = positions.every((p) => p.account_id === clientA.accountId) && positions.length >= 1;
    const ok = res.status === 200 && belongsOnlyToA;
    record('LIVE-R11-P03', 'Authorised investment view: P1 accesses client A investments (ALLOW), data belongs only to A', ok ? 'PASS' : 'FAIL', `status=${res.status} positions=${JSON.stringify(positions)}`);
  }

  // -------------------------------------------------------------------
  // LIVE-R11-P05: Report access, both directions
  // -------------------------------------------------------------------
  {
    const grantRes = await app(`/api/professional-access/relationships/${relId}/scopes`, { cookie: clientA.cookie, method: 'POST', body: { scope: 'VIEW_REPORTS' } });
    const res = await app(`/api/professional-access/proxy/report?clientUserId=${clientA.id}&reportId=${clientA.reportId}`, { cookie: p1.cookie });
    const data = res.json?.data ?? res.json;
    const ownReport = await sb(`/rest/v1/reports?id=eq.${clientA.reportId}`);
    const own = ownReport.json?.[0];
    const sameReport = data?.report?.id === clientA.reportId && data?.report?.status === own?.status;
    const logRow = await sb(`/rest/v1/professional_report_access_log?relationship_id=eq.${relId}`);
    const ok = grantRes.status === 200 && res.status === 200 && sameReport && (logRow.json?.length ?? 0) >= 1;
    record('LIVE-R11-P05', 'Report access: VIEW_REPORTS granted -> ALLOW, uses the SAME R10 report (no professional-specific recalculation), access logged', ok ? 'PASS' : 'FAIL', `grantStatus=${grantRes.status} reportStatus=${res.status} reportId=${data?.report?.id} expected=${clientA.reportId} accessLogRows=${logRow.json?.length}`);
  }

  // -------------------------------------------------------------------
  // LIVE-R11-P06: Raw document privacy (critical)
  // -------------------------------------------------------------------
  {
    // P1 has structured (VIEW_INVESTMENTS) + VIEW_REPORTS -- but NO raw
    // document scope exists in R11 at all (permissions.ts's
    // isRawDocumentScopeSupported() === false, confirmed by static read).
    // Attempt the real Storage API directly with P1's own session token
    // (not admin) against client A's real uploaded object.
    const downloadRes = await fetch(`${BASE}/storage/v1/object/investment-source-documents/${clientA.objectKey}`, {
      headers: { apikey: ANON, Authorization: `Bearer ${p1.session.access_token}` },
    });
    const signRes = await fetch(`${BASE}/storage/v1/object/sign/investment-source-documents/${clientA.objectKey}`, {
      method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${p1.session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 60 }),
    });
    // There is also no app API route at all that could serve a raw document
    // to a professional (verified by static inspection: only 2 proxy routes
    // exist, investments-summary and report, neither touches
    // ii_source_documents/storage). Confirm that surface genuinely doesn't
    // exist rather than assuming.
    const noProxyRoute = await app(`/api/professional-access/proxy/raw-document?clientUserId=${clientA.id}&documentId=${clientA.docId}`, { cookie: p1.cookie });
    const ok = !downloadRes.ok && !signRes.ok && noProxyRoute.status === 404;
    record('LIVE-R11-P06', 'Raw document privacy: P1 has structured access but NO raw-document scope (R11 has no such grantable scope at all) -- direct storage download/sign DENIED, no app route exists to serve one', ok ? 'PASS' : 'FAIL', `download.status=${downloadRes.status} sign.status=${signRes.status} noProxyRoute.status=${noProxyRoute.status}`);
  }

  // -------------------------------------------------------------------
  // LIVE-R11-P09: Cross-client attack (P1 authorised only for A)
  // -------------------------------------------------------------------
  {
    const invRes = await app(`/api/professional-access/proxy/investments-summary?clientUserId=${clientB.id}`, { cookie: p1.cookie });
    const repRes = await app(`/api/professional-access/proxy/report?clientUserId=${clientB.id}&reportId=${clientB.reportId}`, { cookie: p1.cookie });
    const relForgeRes = await asUserRest(`/rest/v1/professional_relationships?client_user_id=eq.${clientB.id}&professional_user_id=eq.${p1.id}`, { accessToken: p1.session.access_token });
    const ok = invRes.status === 403 && repRes.status === 403 && (relForgeRes.json?.length ?? 0) === 0;
    record('LIVE-R11-P09', 'Cross-client attack: P1 attempts Client B (valid real IDs, never authorised) investments/report/relationship access -- all DENIED', ok ? 'PASS' : 'FAIL', `inv.status=${invRes.status} report.status=${repRes.status} relLeak=${relForgeRes.json?.length}`);
  }

  // -------------------------------------------------------------------
  // LIVE-R11-P10: Second professional (no role inheritance)
  // -------------------------------------------------------------------
  {
    const invRes = await app(`/api/professional-access/proxy/investments-summary?clientUserId=${clientA.id}`, { cookie: p2.cookie });
    const repRes = await app(`/api/professional-access/proxy/report?clientUserId=${clientA.id}&reportId=${clientA.reportId}`, { cookie: p2.cookie });
    const clientListRes = await app('/api/professional-access/clients', { cookie: p2.cookie });
    const clientListData = (clientListRes.json?.data ?? clientListRes.json)?.clients ?? [];
    const ok = invRes.status === 403 && repRes.status === 403 && clientListData.length === 0;
    record('LIVE-R11-P10', 'Second professional: P2 not authorised for client A -- DENIED, no professional-role inheritance, P2 client list empty', ok ? 'PASS' : 'FAIL', `inv.status=${invRes.status} report.status=${repRes.status} p2ClientList=${JSON.stringify(clientListData)}`);
  }

  // -------------------------------------------------------------------
  // LIVE-R11-P12: Professional scope forgery
  // -------------------------------------------------------------------
  {
    // (a) P1 self-adds a new scope via the real API route -- clientUserId
    // is derived from session, not client-supplied, so this must fail the
    // ownership check inside grantScope() even though the ROUTE itself has
    // no separate "are you the client" gate of its own.
    const selfGrant = await app(`/api/professional-access/relationships/${relId}/scopes`, { cookie: p1.cookie, method: 'POST', body: { scope: 'VIEW_GOALS' } });
    const grantedAfter = await sb(`/rest/v1/professional_permission_scopes?relationship_id=eq.${relId}&scope=eq.VIEW_GOALS`);
    // (b) P1 attempts direct scope-row forgery via raw PostgREST (insert +
    // update revoked_at back to null on an already-revoked grant).
    const rawInsert = await asUserRest('/rest/v1/professional_permission_scopes', { accessToken: p1.session.access_token, method: 'POST', body: { relationship_id: relId, scope: 'VIEW_TAX_SUMMARY', granted_by: 'client' } });
    // (c) P1 attempts to extend expiry / change consent on their own relationship directly.
    const rawExpiry = await asUserRest(`/rest/v1/professional_relationships?id=eq.${relId}`, { accessToken: p1.session.access_token, method: 'PATCH', body: { expires_at: '2099-01-01T00:00:00Z' } });
    const relAfter = await sb(`/rest/v1/professional_relationships?id=eq.${relId}`);
    // (d) P1 attempts to unrevoke a DIFFERENT (P2/nobody) relationship or
    // activate one not sent to them -- reuse P2's non-existent relationship
    // with A as the "activate another relationship" attempt.
    const activateOther = await asUserRest('/rest/v1/professional_relationships', { accessToken: p2.session.access_token, method: 'POST', body: { client_user_id: clientA.id, professional_user_id: p2.id, status: 'active', invited_by: 'professional' } });
    const p2RelAfter = await sb(`/rest/v1/professional_relationships?client_user_id=eq.${clientA.id}&professional_user_id=eq.${p2.id}`);
    // NOTE: PostgREST's RLS-silent-deny behaviour for UPDATE with zero
    // matching rows returns HTTP 200 with an EMPTY result array (not a 4xx
    // status) -- `.ok` alone is not the right signal for "was this write
    // actually applied", only the re-read DB ground truth is. INSERT with
    // no applicable policy DOES return a genuine 4xx (42501/403), which
    // rawInsert/activateOther correctly check via `.ok`/`.status`.
    const grantRowsReturned = (rawInsert.json?.length ?? 0) === 0; // return=representation would show the row if it were actually inserted
    const expiryUnchanged = relAfter.json?.[0]?.expires_at === null;
    const noActivation = p2RelAfter.json?.length === 0 || p2RelAfter.json?.[0]?.status !== 'active';
    const ok = selfGrant.status !== 200 && (grantedAfter.json?.length ?? 0) === 0 && !rawInsert.ok && grantRowsReturned && expiryUnchanged && noActivation;
    record('LIVE-R11-P12', 'Professional scope forgery: self-add-permission (API + raw insert), extend-expiry, activate-another-relationship -- all BLOCKED, DB ground truth verified unchanged', ok ? 'PASS' : 'FAIL', `selfGrant.status=${selfGrant.status} grantedAfter=${grantedAfter.json?.length} rawInsert.status=${rawInsert.status} rawInsertRows=${rawInsert.json?.length} rawExpiry.status=${rawExpiry.status}(200-with-empty-body-is-normal-RLS-silent-deny) expiresAtAfter=${relAfter.json?.[0]?.expires_at} activateOther.status=${activateOther.status} p2RelAfter=${JSON.stringify(p2RelAfter.json)}`);
  }

  // -------------------------------------------------------------------
  // LIVE-R11-P07: Scope reduction (SAME session before/after)
  // -------------------------------------------------------------------
  {
    const beforeInv = await app(`/api/professional-access/proxy/investments-summary?clientUserId=${clientA.id}`, { cookie: p1.cookie });
    const beforeRep = await app(`/api/professional-access/proxy/report?clientUserId=${clientA.id}&reportId=${clientA.reportId}`, { cookie: p1.cookie });
    const revokeRes = await app(`/api/professional-access/relationships/${relId}/scopes?scope=VIEW_INVESTMENTS`, { cookie: clientA.cookie, method: 'DELETE' });
    const afterInv = await app(`/api/professional-access/proxy/investments-summary?clientUserId=${clientA.id}`, { cookie: p1.cookie });
    const afterRep = await app(`/api/professional-access/proxy/report?clientUserId=${clientA.id}&reportId=${clientA.reportId}`, { cookie: p1.cookie });
    const ok = beforeInv.status === 200 && beforeRep.status === 200 && revokeRes.status === 200 && afterInv.status === 403 && afterRep.status === 200;
    record('LIVE-R11-P07', 'Scope reduction: VIEW_INVESTMENTS revoked (VIEW_REPORTS kept) -- SAME P1 session: investments now DENY, reports still ALLOW', ok ? 'PASS' : 'FAIL', `before(inv=${beforeInv.status},rep=${beforeRep.status}) revoke.status=${revokeRes.status} after(inv=${afterInv.status},rep=${afterRep.status})`);
  }

  // -------------------------------------------------------------------
  // LIVE-R11-P08: Revocation (hard gate) -- SAME session before/after
  // -------------------------------------------------------------------
  {
    const beforeRep = await app(`/api/professional-access/proxy/report?clientUserId=${clientA.id}&reportId=${clientA.reportId}`, { cookie: p1.cookie });
    const revokeRes = await app(`/api/professional-access/relationships/${relId}/revoke`, { cookie: clientA.cookie, method: 'POST' });
    // SAME session/cookie retried, not a fresh sign-in.
    const afterRep = await app(`/api/professional-access/proxy/report?clientUserId=${clientA.id}&reportId=${clientA.reportId}`, { cookie: p1.cookie });
    const afterInv = await app(`/api/professional-access/proxy/investments-summary?clientUserId=${clientA.id}`, { cookie: p1.cookie });
    const relAfter = await sb(`/rest/v1/professional_relationships?id=eq.${relId}`);
    // Service-role un-revoke attempt -- the DB trigger must block even the
    // privileged path (spec section 24).
    const svcUnrevoke = await sb(`/rest/v1/professional_relationships?id=eq.${relId}`, { method: 'PATCH', body: { status: 'active' } });
    const relAfterSvcAttempt = await sb(`/rest/v1/professional_relationships?id=eq.${relId}`);
    const ok = beforeRep.status === 200 && revokeRes.status === 200 && afterRep.status === 403 && afterInv.status === 403 && relAfter.json?.[0]?.status === 'revoked' && !svcUnrevoke.ok && relAfterSvcAttempt.json?.[0]?.status === 'revoked';
    record('LIVE-R11-P08', 'Revocation (hard gate): SAME pre-revocation P1 session denied immediately after revoke; service-role un-revoke also blocked by DB trigger', ok ? 'PASS' : 'FAIL', `beforeRep.status=${beforeRep.status} revoke.status=${revokeRes.status} afterRep.status=${afterRep.status} afterInv.status=${afterInv.status} relStatus=${relAfter.json?.[0]?.status} svcUnrevoke.ok=${svcUnrevoke.ok} relStatusAfterSvc=${relAfterSvcAttempt.json?.[0]?.status}`);
  }

  // -------------------------------------------------------------------
  // LIVE-R11-P11: Same-user authoritative forgery (own IDs, valid FKs)
  // -------------------------------------------------------------------
  {
    // Uses client A's OWN transaction/reconciliation-case rows via their
    // OWN session token -- real IDs, real FKs, never malformed UUIDs.
    const accSeed = await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: clientA.id, account_type: 'mf_folio', institution_name: 'Test AMC', country_code: 'IN', currency_code: 'INR', folio_number: `P11-${stamp}`, status: 'active', owner_member_id: clientA.memberId } });
    const accId = accSeed.json?.[0]?.id;
    const instrSeed = await sb('/rest/v1/ii_instruments', { method: 'POST', prefer: 'return=representation', body: { instrument_name: 'P11 Forge Test Fund', instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'provisional', amc_name: 'Test AMC' } });
    const instrId = instrSeed.json?.[0]?.id;
    const txnSeed = await sb('/rest/v1/ii_transactions', { method: 'POST', prefer: 'return=representation', body: { user_id: clientA.id, account_id: accId, instrument_id: instrId, currency_code: 'INR', status: 'parsed', transaction_type: 'purchase', transaction_date: '2026-01-01', units: 10, gross_amount: 1000, source_reference: `P11REF-${stamp}`, transaction_fingerprint: `p11-fp-${stamp}` } });
    const txnId = txnSeed.json?.[0]?.id;

    const forgeTxn = await asUserRest(`/rest/v1/ii_transactions?id=eq.${txnId}`, { accessToken: clientA.session.access_token, method: 'PATCH', body: { status: 'review_required' } });
    const txnAfter = await sb(`/rest/v1/ii_transactions?id=eq.${txnId}`);

    const caseSeed = await sb('/rest/v1/ii_reconciliation_cases', { method: 'POST', prefer: 'return=representation', body: { user_id: clientA.id, subject_type: 'transaction', subject_id: txnId, status: 'open', discrepancy_type: 'cross_source_conflict', severity: 'high' } });
    const caseId = caseSeed.json?.[0]?.id;
    const forgeCase = await asUserRest(`/rest/v1/ii_reconciliation_cases?id=eq.${caseId}`, { accessToken: clientA.session.access_token, method: 'PATCH', body: { status: 'resolved', resolution_method: 'auto_resolved_cross_source_precedence', resolved_by_actor_type: 'system' } });
    const caseAfter = await sb(`/rest/v1/ii_reconciliation_cases?id=eq.${caseId}`);

    const txnUnchanged = txnAfter.json?.[0]?.status !== 'review_required';
    const caseUnchanged = caseAfter.json?.[0]?.resolved_by_actor_type !== 'system' && caseAfter.json?.[0]?.resolution_method !== 'auto_resolved_cross_source_precedence';
    const ok = txnUnchanged && caseUnchanged;
    record(
      'LIVE-R11-P11',
      'Same-user authoritative forgery: client A, own valid IDs, direct PATCH of authoritative fields (transaction status, reconciliation system-resolution/provenance) -- MUST be BLOCKED',
      ok ? 'PASS' : 'FAIL',
      `forgeTxn.status=${forgeTxn.status} txnStatusAfter=${txnAfter.json?.[0]?.status} forgeCase.status=${forgeCase.status} caseActorTypeAfter=${caseAfter.json?.[0]?.resolved_by_actor_type} caseMethodAfter=${caseAfter.json?.[0]?.resolution_method} -- fix WRITTEN as migration 0087 (proven correct via fresh PGlite replay, scripts/r11_rls_certification.mjs Section 13) but NOT YET applied to this live DEV database: no DDL execution mechanism is available in this sandbox (no exec_sql RPC, no Management API token, no Postgres connection string -- confirmed via 'supabase projects list'). This is a genuine live FAIL against the CURRENT unpatched DEV schema, disclosed precisely, not downgraded to "blocked" language.`
    );
  }

  // -------------------------------------------------------------------
  // Live Professional Matrix (spec section 22)
  // -------------------------------------------------------------------
  console.log('\n=== LIVE PROFESSIONAL MATRIX ===');
  const matrix = [
    ['P1', 'A-Investments', 'granted then revoked in P07/P08', 'DENY (post-revocation)', results.find((r) => r.id === 'LIVE-R11-P08')?.status === 'PASS' ? 'DENY' : 'see P08'],
    ['P1', 'A-Reports', 'not granted (before P05)', 'DENY', results.find((r) => r.id === 'LIVE-R11-P04')?.status === 'PASS' ? 'DENY' : 'see P04'],
    ['P1', 'A-Reports', 'granted (P05)', 'ALLOW', results.find((r) => r.id === 'LIVE-R11-P05')?.status === 'PASS' ? 'ALLOW' : 'see P05'],
    ['P1', 'B-Investments', 'n/a (not authorised for B)', 'DENY', results.find((r) => r.id === 'LIVE-R11-P09')?.status === 'PASS' ? 'DENY' : 'see P09'],
    ['P2', 'A-Investments', 'n/a (never invited)', 'DENY', results.find((r) => r.id === 'LIVE-R11-P10')?.status === 'PASS' ? 'DENY' : 'see P10'],
    ['P1 (revoked)', 'A-Investments', 'revoked', 'DENY', results.find((r) => r.id === 'LIVE-R11-P08')?.status === 'PASS' ? 'DENY' : 'see P08'],
  ];
  for (const [actor, resource, scope, expected, actual] of matrix) {
    console.log(`  ${actor} x ${resource} (${scope}) = expected ${expected}, actual ${actual}`);
  }

  console.log('\n=== FINAL RESULTS ===');
  for (const r of results) console.log(`${r.status}\t${r.id}\t${r.description}`);
  const passCount = results.filter((r) => r.status === 'PASS').length;
  console.log(`\n${passCount}/${results.length} PASS`);

  fs.writeFileSync(path.join(repoRoot, 'r11-professional-live-dev-results.local.json'), JSON.stringify({ stamp, results, matrix, cleanupUsers: cleanup.users, relId, clientA: { id: clientA.id, reportId: clientA.reportId }, clientB: { id: clientB.id, reportId: clientB.reportId }, p1: { id: p1.id }, p2: { id: p2.id } }, null, 2));
  console.log('\nWrote r11-professional-live-dev-results.local.json');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
